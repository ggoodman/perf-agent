//@ts-check
'use strict';

const Code = require('code');
const Lab = require('lab');

const { PerfAgent } = require('../');

const lab = Lab.script();
const { describe, it } = lab;
const expect = Code.expect;

const MS_PER_NS = 1e6;
const RESOLVED_PROMISE = Promise.resolve();

exports.lab = lab;

describe('stack traces', () => {
    it('will trigger a BlockedEvent with an asynchronous stack trace', async () => {
        const agent = new PerfAgent({
            threshold: 100,
            captureAsyncStackTraces: true,
        });

        let blockedEventTriggered = false;

        agent.onBlocked(event => {
            blockedEventTriggered = true;

            expect(event).to.exist();
            expect(event.duration)
                .to.be.a.number()
                .and.be.greaterThan(100 * MS_PER_NS);
            expect(event.stacks).to.be.an.array();
            expect(event.stacks.length).to.equal(2);
            expect(event.stacks[0]).to.be.an.array();
            expect(event.stacks[0].length).to.be.greaterThan(2);
            expect(event.stacks[1]).to.be.an.array();
            expect(event.stacks[1].length).to.be.greaterThan(2);
        });

        agent.start();
        // async_hooks will reliably trigger on chained promises
        await RESOLVED_PROMISE.then(firstCallback).then(secondCallback);
        agent.stop();

        expect(blockedEventTriggered).to.equal(true);

        function firstCallback() {
            const end = Date.now() + 10;

            while (Date.now() <= end) {
                // Do nothing
            }
        }

        function secondCallback() {
            const end = Date.now() + 100;

            while (Date.now() <= end) {
                // Do nothing
            }
        }
    });
});
