import { describe, expect, it } from 'vitest'
import type { MqttMessageRecord } from '../../../shared/contracts'
import {
  parsePayloadTypeAssignments,
  payloadTypeAssignmentKey,
  recognizePayloadType,
} from './payload-type'

const record = (payload: unknown, timestamp = 1): MqttMessageRecord => ({
  id: String(timestamp),
  profileId: 'profile',
  direction: 'in',
  topic: 'thing/product/DOCK-1/events',
  payload: JSON.stringify(payload),
  qos: 1,
  retain: false,
  timestamp,
  size: 1,
})

describe('payload type recognition', () => {
  it('recognizes speaker and parachute payloads from explicit protocol signals', () => {
    expect(recognizePayloadType([
      record({ method: 'speaker_tts_play_start', data: { psdk_index: 1 } }),
    ], 1)).toEqual({ type: 'speaker', evidence: '方法 speaker_tts_play_start' })

    expect(recognizePayloadType([
      record({ method: 'custom_data_transmission_from_psdk', data: { psdk_index: 2, payload_type: 'parachute' } }),
    ], 2)).toEqual({ type: 'parachute', evidence: '字段 payload_type=parachute' })
  })

  it('does not guess a type from opaque PSDK data', () => {
    expect(recognizePayloadType([
      record({
        method: 'custom_data_transmission_from_psdk',
        data: { psdk_index: 2, value: 'speaker_parachute_ENC' },
      }),
    ], 2)).toBeUndefined()
  })

  it('keeps assignments scoped to profile, gateway and PSDK index', () => {
    expect(payloadTypeAssignmentKey('p1', 'dock-1', 2)).toBe('p1:dock-1:2')
    expect(parsePayloadTypeAssignments({
      version: 1,
      assignments: {
        'p1:dock-1:1': { mode: 'manual', manualType: 'speaker' },
        'p1:dock-1:2': { mode: 'manual', manualType: 'camera' },
        'p1:dock-1:3': { mode: 'manual' },
        broken: { mode: 'sometimes' },
      },
    })).toEqual({
      'p1:dock-1:1': { mode: 'manual', manualType: 'speaker' },
    })
  })
})
