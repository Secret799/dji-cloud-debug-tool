import { describe, expect, it } from 'vitest'
import { formatJsonText } from './json'

describe('JSON text formatting', () => {
  it('pretty prints a JSON object', () => {
    expect(formatJsonText('{"flightId":"A-1","position":{"lat":31.2}}')).toBe([
      '{',
      '  "flightId": "A-1",',
      '  "position": {',
      '    "lat": 31.2',
      '  }',
      '}',
    ].join('\n'))
  })

  it('pretty prints newline-delimited JSON payloads', () => {
    expect(formatJsonText('{"height":42}\n{"mode":"mission"}')).toBe([
      '{',
      '  "height": 42',
      '}',
      '',
      '{',
      '  "mode": "mission"',
      '}',
    ].join('\n'))
  })

  it('rejects plain text and incomplete JSON', () => {
    expect(formatJsonText('plain SEI payload')).toBeUndefined()
    expect(formatJsonText('{"height":')).toBeUndefined()
    expect(formatJsonText()).toBeUndefined()
  })
})
