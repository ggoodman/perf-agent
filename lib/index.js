//@ts-check
'use strict';

const AsyncHooks = require('async_hooks');

const SKIP_FRAME_RX = /^(?:internal\/)?async_hooks.js$/;
const NS_PER_SEC = 1e9;
const NS_PER_MS = 1e6;
const STACK_RECEIVER = Object.create(null);
const STACK_SEPARATOR = '-'.repeat(40);

/** @typedef {number} AsyncId */

/** @typedef {(event: BlockedEvent) => void} BlockedCallback */

/**
 * @typedef Disposable
 * @property {() => void} dispose
 */

/**
 * @typedef FlowGraphNode
 * @property {AsyncId} asyncId
 * @property {NodeJS.CallSite[]} stack
 * @property {AsyncId} triggerAsyncId
 * @property {string} type
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
        return `Slow synchronous block (${Math.round(
            this.duration / NS_PER_MS
        )}ms):\n--> ${this.stacks.map(stack => stack.join('\n    ')).join('\n--> ')}`;
    }
}

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

        const stack = this._useAsyncStackTraces ? createStack(1) : [];

        this._flowGraph.set(asyncId, {
            asyncId,
            stack,
            triggerAsyncId,
            type,
        });
    }

    _asyncBefore(asyncId) {
        if (!this._currentSkipList.has(asyncId)) {
            this._timings.set(asyncId, process.hrtime());
        }
    }

    _asyncAfter(asyncId) {
        const timings = this._timings.get(asyncId);

        if (timings) {
            const diff = process.hrtime(timings);
            const delta = diff[0] * NS_PER_SEC + diff[1];

            if (delta > this._threshold && this._onBlockedCallbacks.length) {
                this.executeWithoutTracing(() => {
                    const stacks = [];

                    let nextAsyncId = asyncId;

                    while (this._flowGraph.has(nextAsyncId)) {
                        const node = this._flowGraph.get(nextAsyncId);

                        if (node.stack.length) {
                            stacks.push(node.stack);
                        }

                        nextAsyncId = node.triggerAsyncId;
                    }

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
        /** @type {(string | NodeJS.CallSite)[]} */
        const stack = createStack(0, callsite || this.captureStackTrace);

        let nextAsyncId = asyncId;

        while (this._flowGraph.has(nextAsyncId)) {
            const node = this._flowGraph.get(nextAsyncId);

            if (stack.length) {
                stack.push(STACK_SEPARATOR);
            }
            stack.push.apply(stack, node.stack);

            nextAsyncId = node.triggerAsyncId;
        }

        Object.defineProperty(receiver, 'stack', {
            get() {
                return stack.join('\n    at ');
            },
        });
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

exports.PerfAgent = PerfAgent;

function captureRawTraceData(_, trace) {
    return trace;
}

function createStack(skipFrames, callsite) {
    const prepareStackTrace = Error.prepareStackTrace;
    const stackTraceLimit = Error.stackTraceLimit;

    Error.stackTraceLimit = Infinity;
    Error.captureStackTrace(STACK_RECEIVER, callsite || createStack);
    Error.stackTraceLimit = stackTraceLimit;

    Error.prepareStackTrace = captureRawTraceData;
    /** @type {NodeJS.CallSite[]} */
    const stack = STACK_RECEIVER.stack;
    Error.prepareStackTrace = prepareStackTrace;

    return (
        stack
            // .map(toSimpleFrame)
            .slice(skipFrames)
            .filter(filterFrames)
    );
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
