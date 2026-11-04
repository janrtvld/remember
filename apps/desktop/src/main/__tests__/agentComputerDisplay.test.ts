import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentComputerExecutionKey,
  normalizeAgentComputer,
  normalizeAgentDisplayHost,
  type RemoteAgentComputer,
} from '@remember/shared'
import { isAgentDisplayUrl } from '../agentComputerDisplay'

const computer: RemoteAgentComputer = {
  kind: 'remote',
  endpoint: 'ws://127.0.0.1:47832/',
  workspace: '/Users/ai/Agent',
  displayHost: 'mac-mini.local',
}

test('display hosts are explicit, canonical and contain no URL or credentials', () => {
  for (const [input, expected] of [
    ['  Mac-Mini.local  ', 'mac-mini.local'],
    ['AI’s Mac mini._rfb._tcp.local', 'AI’s Mac mini._rfb._tcp.local'],
    ['192.168.1.2', '192.168.1.2'],
    ['[2001:0DB8::1]', '[2001:db8::1]'],
    ['', undefined],
    [undefined, undefined],
  ])
    assert.equal(normalizeAgentDisplayHost(input), expected)
  for (const value of [
    'vnc://mac-mini.local',
    'ai@Mac._rfb._tcp.local',
    'a.b._rfb._tcp.local',
    'a%2F._rfb._tcp.local',
    'a/b._rfb._tcp.local',
    'a\nB._rfb._tcp.local',
    `${'é'.repeat(32)}._rfb._tcp.local`,
    'AI’s Mac mini._ssh._tcp.local',
    'http://mac-mini.local',
    'ai@mac-mini.local',
    'ai:secret@mac-mini.local',
    'mac-mini.local:5900',
    'mac-mini.local/path',
    'mac-mini.local?x',
    'mac-mini.local#x',
    'mac-mini.local\\x',
    'mac-mini.local%2fpath',
    'mac\nmini.local',
    'mac mini.local',
    '-mini.local',
    'mini..local',
    'mini.local.',
    '127.1',
    '2130706433',
    '0177.0.0.1',
    '0x7f000001',
    '999.2.3.4',
    '[not:ipv6]',
    '[fe80::1%en0]',
    'あ.local',
    'a'.repeat(64),
    null,
    {},
    123,
  ])
    assert.throws(() => normalizeAgentDisplayHost(value), /invalid-agent-computer-display-host/, String(value))
  const { displayHost: _host, ...old } = computer
  assert.deepEqual(normalizeAgentComputer(old), old)
  assert.equal(
    agentComputerExecutionKey(computer),
    JSON.stringify(old),
    'Existing policy identity must not change on upgrade'
  )
  assert.equal(agentComputerExecutionKey(old), agentComputerExecutionKey(computer))
  assert.notEqual(agentComputerExecutionKey(computer), agentComputerExecutionKey({ ...computer, workspace: '/other' }))
})

test('embedded remote-display links cannot launch the OS screen-sharing app', () => {
  for (const url of ['vnc://other.local', 'VNC://other.local', 'v\nnc://other.local', ' vnc://other.local'])
    assert(isAgentDisplayUrl(url))
  for (const url of ['https://example.com', '/wiki/', 'invalid']) assert.equal(isAgentDisplayUrl(url), false)
})
