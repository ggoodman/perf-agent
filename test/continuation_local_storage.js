//@ts-check
'use strict';

const Code = require('code');
const Lab = require('lab');

const { PerfAgent } = require('../');

const lab = Lab.script();
const { describe, it } = lab;
const expect = Code.expect;

const RESOLVED_PROMISE = Promise.resolve();

exports.lab = lab;

describe('continuation local storage', () => {
    it.only('will propagate data through continuations', async () => {
        const agent = new PerfAgent({
            threshold: Infinity,
            captureAsyncStackTraces: true,
        });

        agent.start();
        await RESOLVED_PROMISE.then(
            () =>
                new Promise(resolve => {
                    agent.set('top', 0);

                    setTimeout(() => {
                        expect(agent.get('top')).to.equal(0);
                        expect(agent.get('nextTick')).to.be.undefined();
                    });

                    process.nextTick(() => {
                        agent.set('top', 1);
                        agent.set('nextTick', 1);

                        process.nextTick(() => {
                            expect(agent.get('nextTick')).to.equal(1);
                            expect(agent.get('top')).to.equal(1);
                            agent.set('top', 2);
                            expect(agent.get('top')).to.equal(2);
                        });

                        setTimeout(() => {
                            expect(agent.get('nextTick')).to.equal(1);
                            expect(agent.get('top')).to.equal(1);
                            agent.set('top', 2);
                            expect(agent.get('top')).to.equal(2);

                            return resolve();
                        });
                    });
                })
        );
        agent.stop();
    });
});
