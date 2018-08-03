# Perf Agent

An agent designed to give insight into the performance of your node.js code.

Perf Agent uses [async_hooks](https://nodejs.org/docs/latest-v8.x/api/async_hooks.html) to observe the duration of each synchronous block of code. To gain further insight, Perf Agent allows for the collection of deep asynchronous stack traces.

When asynchronous stack traces are enabled, it is also possible to use the agent as an alternative to `Error.captureStackTrace` in order to see the full, asynchronous call stack leading up to an event.

## Example

```js
const agent = new PerfAgent({
    captureAsyncStackTraces: true,
    threshold: 100, // Trigger events if a block exceeds 100ms
});

agent.onBlocked(e => {
    // e.duration will be the number of nanoseconds elapsed in a synchronous block
    // e.stacks is an array of arrays of CallSite objects
    // e.stacks[0][0] is the CallSite that *triggered* the block that exceeded the threshold
    console.log(e.toString()); // Log the event which will include a deep stack trace
});
agent.start(); // The agent must be explicitly started
```

Here's what a deep stack trace might look like (from the tests). The lines beginning with an arrow represent distinct asynchronous contexts. Below you can see that two Promise resolution handlers were invoked on the same line and that the 2nd blocked for 101ms.

```
Slow synchronous block (101ms):
--> Promise.then (<anonymous>)
    it (/Users/ggoodman/Projects/experiments/perf-agent/test/stack_traces.js:46:52)
    Immediate.setImmediate [as _onImmediate] (/Users/ggoodman/Projects/experiments/perf-agent/node_modules/lab/lib/runner.js:597:31)
    runCallback (timers.js:810:20)
    tryOnImmediate (timers.js:768:5)
    processImmediate [as _immediateCallback] (timers.js:745:5)
--> Promise.then (<anonymous>)
    it (/Users/ggoodman/Projects/experiments/perf-agent/test/stack_traces.js:46:32)
    Immediate.setImmediate [as _onImmediate] (/Users/ggoodman/Projects/experiments/perf-agent/node_modules/lab/lib/runner.js:597:31)
    runCallback (timers.js:810:20)
    tryOnImmediate (timers.js:768:5)
    processImmediate [as _immediateCallback] (timers.js:745:5)
```

## API

### `PerfAgent`

```js
const { PerfAgent } = require('perf-agent');
```

An instance of the perf agent.

**`new PerfAgent(options)`**: create a new `PerfAgent` instance where `options` must be an object having:

-   `captureAsyncStackTraces?: boolean` whether asynchronous stack traces should be collected. There can be a major performance impact in collecting these.
-   `threshold: number` the threshold in milliseconds above which `BlockedEvent`s will be triggered

**`.start()`**: start capturing async stack traces (if enabled) and observing for slow synchronous blocks.

**`.stop()`**: stop capturing async stack traces (if enabled) and observing for slow synchronous blocks.

**`.captureStackTrace(receiver, callsite)`**: capture a stack trace (which may be augmented with asynchronous frames, if enabled), similar to `Error.captureStackTrace`.

**`.executeWithoutTracing(cb)`**: execute the provided callback function such that it (and it's continuations) will not be traced.

**`.onBlocked(cb)`**: register a callback that will be invoked when a synchronous block exceeds the configured threshold where:

-   `cb: (event: BlockedEvent): void`

Returns a `Disposable` whose `.dispose()` method can be invoked to unregister the callback.

**`.setUseAsyncStackTraces(enabled)`**: toggle the collection of async stack traces where:

-   `enabled: boolean` whether async stack traces should be collected.

> _Note: when enabled, any pre-existing asynchronous contexts will have empty stacks. In other words, retroactive collection is not possible._

### `BlockedEvent`

`BlockedEvent` represents the data collected about a slow synchronous block.

**`.duration: number`**: The number of nanoseconds elapsed while executing the block.

**`.stacks: NodeJS.CallSite[][]`**: An array of stack traces where each element in the top-level array represents a synchronous block's stack trace.

Stacks and their elements are ordered such that the newest events are first.

You can think of each element in the top-level array as being a logical consequence of the previous element.

**`.toString()`**: Generate a string representation of the event.
