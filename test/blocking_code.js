//@ts-check
'use strict';

const Async = require('async');
const Code = require('code');
const Lab = require('lab');

const { PerfAgent } = require('../');

const lab = Lab.script();
const { describe, it } = lab;
const expect = Code.expect;

const MS_PER_NS = 1e6;
const RESOLVED_PROMISE = Promise.resolve();

exports.lab = lab;

describe('blocking code', () => {
    it('will trigger a BlockedEvent if a synchronous block exceeds the threshold', async () => {
        const agent = new PerfAgent({
            threshold: 100,
            captureAsyncStackTraces: false,
        });

        let blockedEventTriggered = false;

        agent.onBlocked(event => {
            blockedEventTriggered = true;

            expect(event).to.exist();
            expect(event.duration)
                .to.be.a.number()
                .and.be.greaterThan(100 * MS_PER_NS);
        });

        agent.start();
        // async_hooks will reliably trigger on chained promises
        await RESOLVED_PROMISE.then(() => {
            const end = Date.now() + 100;

            while (Date.now() <= end) {
                // Do nothing
            }
        });
        agent.stop();

        expect(blockedEventTriggered).to.equal(true);
    });

    it('will not trigger a BlockedEvent if a synchronous block does not exceed the threshold', async () => {
        const agent = new PerfAgent({
            threshold: 200,
            captureAsyncStackTraces: false,
        });

        let blockedEventTriggered = false;

        agent.onBlocked(() => {
            blockedEventTriggered = true;
        });

        agent.start();
        // async_hooks will reliably trigger on chained promises
        await RESOLVED_PROMISE.then(() => {
            const end = Date.now() + 100;

            while (Date.now() <= end) {
                // Do nothing
            }
        });
        agent.stop();

        expect(blockedEventTriggered).to.equal(false);
    });

    it('will not trigger a BlockedEvent if multiple synchronous blocks exceed the threshold in aggregate', async () => {
        const agent = new PerfAgent({
            threshold: 200,
            captureAsyncStackTraces: false,
        });

        let blockedEventTriggered = false;

        agent.onBlocked(() => {
            blockedEventTriggered = true;
        });

        agent.start();
        // async_hooks will reliably trigger on chained promises
        await RESOLVED_PROMISE.then(() => {
            const end = Date.now() + 100;

            while (Date.now() <= end) {
                // Do nothing
            }
        }).then(() => {
            const end = Date.now() + 100;

            while (Date.now() <= end) {
                // Do nothing
            }
        });
        agent.stop();

        expect(blockedEventTriggered).to.equal(false);
    });

    it("will give useful insight into a slow synchronous block using require('async')", async () => {
        const agent = new PerfAgent({
            threshold: 100,
            captureAsyncStackTraces: true,
        });

        let blockedEventTriggered = false;

        agent.onBlocked(() => {
            blockedEventTriggered = true;
        });

        agent.start();

        await new Promise(resolve =>
            Async.series(
                [
                    next => process.nextTick(next),
                    next => setImmediate(next),
                    next => setTimeout(next),
                ],
                () => {
                    const end = Date.now() + 100;

                    while (Date.now() <= end) {
                        // Do nothing
                    }

                    return resolve();
                }
            )
        );

        agent.stop();

        expect(blockedEventTriggered).to.equal(true);
    });
});
