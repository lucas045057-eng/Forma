import { createCodingAgentMock, type MockScenario } from './mock-server.ts';

const scenario = process.env.CODING_AGENT_MOCK_SCENARIO as MockScenario | undefined;
const mock = await createCodingAgentMock({ key: process.env.CODING_AGENT_MOCK_KEY ?? 'mock-only', scenario });
const address = await mock.listen({ host: '127.0.0.1', port: Number(process.env.CODING_AGENT_MOCK_PORT ?? 4011) });
console.log(`Coding Agent mock: ${address}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void mock.close(); });
