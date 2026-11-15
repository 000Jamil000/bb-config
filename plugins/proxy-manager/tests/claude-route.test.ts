import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyClaudeRoute, isClaudeProcess, linuxPeers, macPeers, type ClaudeSnapshot } from '../claude-route.ts';
const api = ['192.0.2.10'];
const snapshot = (overrides: Partial<ClaudeSnapshot> = {}): ClaudeSnapshot => ({ env: {}, peers: [], readable: true, ...overrides });
test('absence of proxy configuration does not assert a direct live connection', () => {
  assert.equal(classifyClaudeRoute(snapshot(), api).state, 'unknown');
  assert.equal(classifyClaudeRoute(snapshot({ peers: [{ address: api[0], port: 443 }] }), api).state, 'direct');
  assert.equal(classifyClaudeRoute(snapshot({ peers: [{ address: '192.0.2.22', port: 443 }] }), api).state, 'unknown');
});
test('a configured proxy is confirmed only by the process socket; secrets stay private', () => {
  const proxy = new URL('http://proxy.invalid:3128');
  proxy.username = 'secret-user'; proxy.password = 'secret-password';
  const env = { HTTPS_PROXY: proxy.toString() };
  assert.equal(classifyClaudeRoute(snapshot({ env }), api, ['192.0.2.20']).state, 'unknown');
  const checked = classifyClaudeRoute(snapshot({ env, peers: [{ address: '192.0.2.20', port: 3128 }] }), api, ['192.0.2.20']);
  assert.equal(checked.state, 'proxy');
  assert.ok(!JSON.stringify(checked).includes('secret'));
  assert.ok(!JSON.stringify(checked).includes('proxy.invalid'));
});
test('ambiguous routes, unreadable process, custom gateways and cloud backends never turn green', () => {
  const peers = [{ address: api[0], port: 443 }, { address: '192.0.2.20', port: 3128 }];
  for (const data of [
    { readable: false, peers },
    { env: { HTTPS_PROXY: 'http://one.invalid', HTTP_PROXY: 'http://two.invalid' }, peers },
    { env: { HTTPS_PROXY: 'http://proxy.invalid:3128' }, peers },
    { env: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' }, peers },
    { env: { CLAUDE_CODE_USE_BEDROCK: '1' }, peers },
  ]) assert.equal(classifyClaudeRoute(snapshot(data), api, ['192.0.2.20']).state, 'unknown');
});
test('only the actual Claude CLI or its BB provider worker qualifies', () => {
  assert.equal(isClaudeProcess(['/root/.local/bin/claude', '--resume', 'session']), true);
  assert.equal(isClaudeProcess(['node', '/runtime/provider-claude-code/hash/host.mjs']), true);
  assert.equal(isClaudeProcess(['node', '/runtime/provider-codex/hash/host.mjs']), false);
  assert.equal(isClaudeProcess(['echo', 'Please ask claude to help']), false);
});
test('Linux TCP decoding excludes other processes and sockets that are not established', () => {
  const table = 'sl local_address rem_address st tx rx tr tm retr inode\n0: 00000000:0000 0A0200C0:01BB 01 0:0 00:0 0 0 0 101\n1: 00000000:0000 0A0200C0:01BB 0A 0:0 00:0 0 0 0 102\n2: 00000000:0000 140200C0:0C38 01 0:0 00:0 0 0 0 103';
  assert.deepEqual(linuxPeers([table], new Set(['101', '102'])), [{ address: api[0], port: 443 }]);
});
test('macOS socket decoding handles IPv4 and IPv6 remote endpoints only', () => {
  assert.deepEqual(macPeers('p123\nn127.0.0.1:12345->192.0.2.10:443\nn[::1]:12345->[2001:db8::1]:443\nn*:443'), [
    { address: api[0], port: 443 }, { address: '2001:db8::1', port: 443 },
  ]);
});
