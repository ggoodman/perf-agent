//@ts-check
'use strict';

const AsyncHooks = require('async_hooks');

let nextMask = 0;

const IS_CONSTRUCTOR = 1 << nextMask++;
const IS_EVAL = 1 << nextMask++;
const IS_TOPLEVEL = 1 << nextMask++;
const IS_METHOD_CALL = 1 << nextMask++;
const IS_NATIVE = 1 << nextMask++;

const SKIP_FRAME_RX = /^(?:internal\/)?async_hooks.js$/;
const NS_PER_SEC = 1e9;
const NS_PER_MS = 1e6;
const STACK_RECEIVER = Object.create(null);

/** @typedef {number} AsyncId */

/** @typedef {(event: BlockedEvent) => void} BlockedCallback */

/**
 * @typedef Disposable
 * @property {() => void} dispose
 */

class BlockedEvent {
    /**
     *
     * @param {number} duration
     * @param {NodeJS.CallSite[][]} stacks
     */
    constructor(duration, stacks) {
        this.duration = duration;
        this.stacks = stacks;
    }

    toString() {
        const stacks = serializeStacks(this.stacks);

        return `Slow synchronous block (${Math.round(
            this.duration / NS_PER_MS
        )}ms)${stacks ? `:\n${stacks}` : ''}`;
    }
}

class Frame {
    /**
     *
     * @param {NodeJS.CallSite} callsite
     */
    constructor(callsite) {
        const isConstructor = callsite.isConstructor();
        const isEval = callsite.isEval();
        const isNative = callsite.isNative();
        const isToplevel = callsite.isToplevel();
        const isMethodCall = !(isToplevel || isConstructor);

        this._mask =
            (isToplevel ? IS_TOPLEVEL : 0) |
            (isConstructor ? IS_CONSTRUCTOR : 0) |
            (isEval ? IS_EVAL : 0) |
            (isNative ? IS_NATIVE : 0) |
            (isMethodCall ? IS_METHOD_CALL : 0);

        this.columnNumber = callsite.getColumnNumber() || 0;
        this.fileName = callsite.getFileName() || 0;
        this.functionName = callsite.getFunctionName();
        this.lineNumber = callsite.getLineNumber();
        this.methodName = callsite.getMethodName();
        this.typeName = callsite.getTypeName();

        this._toString = callsite.toString();
    }

    get isConstructor() {
        return this._mask & IS_CONSTRUCTOR;
    }

    get isEval() {
        return this._mask & IS_EVAL;
    }

    get isMethodCall() {
        return this._mask & IS_METHOD_CALL;
    }

    get isNative() {
        return this._mask & IS_NATIVE;
    }

    get isToplevel() {
        return this._mask & IS_TOPLEVEL;
    }

    /**
     * Return a string representation of the frame
     *
     * Formatting logic taken from: https://github.com/nodejs/node/blob/0f3c2c64d2fe73394e5a40c79f626d9d09c7cd5d/deps/v8/src/messages.cc#L596-L626
     */
    toString() {
        return this._toString;
    }
}

/**
 * @typedef FlowGraphNode
 * @property {AsyncId} asyncId
 * @property {AsyncId} followsAsyncId
 * @property {Frame[]} stack
 * @property {AsyncId} triggerAsyncId
 * @property {string} type
 */

/**
 * @typedef PerfAgentOptions
 * @property {boolean} [captureAsyncStackTraces = false] Whether to capture stack traces that span asynchronous boundaries. Enabling this can have serious performance consequences.
 * @property {number} threshold The threshold in milliseconds at which a blockage event will be triggered
 */

class PerfAgent {
    /**
     *
     * @param {PerfAgentOptions} options
     */
    constructor(options) {
        if (!options || typeof options !== 'object') {
            throw new TypeError('options must be an object');
        }
        if (
            typeof options.threshold !== 'number' ||
            isNaN(options.threshold) ||
            options.threshold < 0
        ) {
            throw new TypeError(
                'options.threshold is required and must be a positive number'
            );
        }

        this._threshold = options.threshold * NS_PER_MS;

        /** @type {Set<AsyncId>} */
        this._currentSkipList = new Set();

        /** @type {Map<AsyncId, FlowGraphNode>} */
        this._flowGraph = new Map();

        /** @type {BlockedCallback[]} */
        this._onBlockedCallbacks = [];

        /** @type {boolean} */
        this._skipContext = false;

        /** @type {Map<AsyncId, {[key: string]: any}>} */
        this._state = new Map();

        /** @type {Map<AsyncId, [number, number]>} */
        this._timings = new Map();

        /** @type {boolean} */
        this._useAsyncStackTraces = !!options.captureAsyncStackTraces;

        const hooks = {
            init: this._asyncInit.bind(this),
            before: this._asyncBefore.bind(this),
            after: this._asyncAfter.bind(this),
            destroy: this._asyncDestroy.bind(this),
        };

        this._asyncHook = AsyncHooks.createHook(hooks);

        this._depth = 0;
    }

    _asyncInit(asyncId, type, triggerAsyncId) {
        if (
            this._skipContext ||
            this._currentSkipList.has(triggerAsyncId) ||
            this._currentSkipList.has(asyncId)
        ) {
            // We're in a flow that we are definitely not interested in tracing
            this._currentSkipList.add(asyncId);
            return;
        }

        const followsAsyncId = AsyncHooks.triggerAsyncId();
        const stack = this._useAsyncStackTraces ? createStack(2) : [];

        this._flowGraph.set(asyncId, {
            asyncId,
            followsAsyncId,
            stack,
            triggerAsyncId,
            type,
        });
    }

    _asyncBefore(asyncId) {
        if (!this._currentSkipList.has(asyncId)) {
            this._depth += 2;
            this._timings.set(asyncId, process.hrtime());
        }
    }

    _asyncAfter(asyncId) {
        const timings = this._timings.get(asyncId);

        if (timings) {
            this._depth -= 2;
            const diff = process.hrtime(timings);
            const delta = diff[0] * NS_PER_SEC + diff[1];

            if (delta > this._threshold && this._onBlockedCallbacks.length) {
                this.executeWithoutTracing(() => {
                    const stacks = this._createStackSet(asyncId);
                    const event = new BlockedEvent(delta, stacks);

                    invokeCallbacks(this._onBlockedCallbacks, event);
                });
            }

            this._timings.delete(asyncId);
        }
    }

    _asyncDestroy(asyncId) {
        this._currentSkipList.delete(asyncId);
        this._flowGraph.delete(asyncId);
        this._timings.delete(asyncId);
    }

    _captureStackTraceForAsyncId(asyncId, receiver, callsite) {
        const stack = createStack(
            0,
            callsite || this._captureStackTraceForAsyncId
        );
        const stacks = this._createStackSet(asyncId, stack);

        Object.defineProperty(receiver, 'stack', {
            get() {
                return serializeStacks(stacks);
            },
        });
    }

    _createStackSet(asyncId, initialStack) {
        const stacks = initialStack ? [initialStack] : [];

        let nextNode = this._flowGraph.get(asyncId);
        while (nextNode) {
            if (nextNode.stack.length) {
                stacks.push(nextNode.stack);
            }

            nextNode =
                this._flowGraph.get(nextNode.triggerAsyncId) ||
                this._flowGraph.get(nextNode.followsAsyncId);
        }

        return stacks;
    }

    /**
     * Capture an asynchronous stack trace, like Error.captureStackTrace
     *
     * @param {Error} receiver an object on which the stack property will be created
     * @param {function} [callsite] the function relative to which we want to capture a trace
     */
    captureStackTrace(receiver, callsite) {
        return this._captureStackTraceForAsyncId(
            AsyncHooks.executionAsyncId(),
            receiver,
            callsite
        );
    }

    /**
     * Execute a function in a context without tracing
     *
     * @param {function} cb a function that will be executed without tracing such that all resulting async operations are also ignored
     */
    executeWithoutTracing(cb) {
        if (typeof cb !== 'function') {
            throw new TypeError('Callback must be a function');
        }

        this._skipContext = true;

        try {
            cb();
        } finally {
            this._skipContext = false;
        }
    }

    /**
     * Register a callback that will be called with a BlockedEvent when a
     * synchronous block's execution time exceeds the configured threshold
     *
     * @param {BlockedCallback} cb
     * @returns {Disposable}
     */
    onBlocked(cb) {
        this._onBlockedCallbacks.push(cb);

        const disposable = {
            dispose: removeCallback.bind(null, this._onBlockedCallbacks, cb),
        };

        return disposable;
    }

    /**
     * Toggle the use of asynchronous stack traces
     *
     * @param {boolean} setting whether to enable asynchronous stack traces (expensive)
     */
    setUseAsyncStackTraces(setting) {
        this._useAsyncStackTraces = !!setting;

        return this;
    }

    /**
     * Start capturing performance data
     */
    start() {
        this._asyncHook.enable();
    }

    /**
     * Stop capturing performance data
     */
    stop() {
        this._asyncHook.disable();
    }
}

exports.BlockedEvent = BlockedEvent;
exports.Frame = Frame;
exports.PerfAgent = PerfAgent;

function captureRawTraceData(_, trace) {
    return trace;
}

function createStack(skipFrames, callsite, stackDepth = Infinity) {
    const prepareStackTrace = Error.prepareStackTrace;
    const stackTraceLimit = Error.stackTraceLimit;

    Error.stackTraceLimit = stackDepth;
    Error.captureStackTrace(STACK_RECEIVER, callsite || createStack);
    Error.stackTraceLimit = stackTraceLimit;

    Error.prepareStackTrace = captureRawTraceData;
    /** @type {NodeJS.CallSite[]} */
    const stack = STACK_RECEIVER.stack;
    Error.prepareStackTrace = prepareStackTrace;

    return stack
        .slice(skipFrames)
        .filter(filterFrames)
        .map(toFrame);
}

/**
 * @param {NodeJS.CallSite} frame
 */
function filterFrames(frame) {
    if (SKIP_FRAME_RX.test(frame.getFileName())) {
        return false;
    }

    return true;
}

function invokeCallbacks(callbacks, ...args) {
    for (const cb of callbacks) {
        cb(...args);
    }
}

function removeCallback(callbacks, cb) {
    const idx = callbacks.indexOf(cb);

    if (idx !== -1) {
        callbacks.splice(idx, 1);
    }
}

function serializeStacks(stacks) {
    return stacks
        .map(stack =>
            stack
                .map(callsite => callsite.toString())
                .filter(entry => entry !== '<anonymous>')
        )
        .filter(stack => stack.length > 0)
        .map(stack => `--> ${stack.join('\n    ')}`)
        .join('\n');
}

function toFrame(callsite) {
    return new Frame(callsite);
}
