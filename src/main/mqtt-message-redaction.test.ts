import { describe, expect, it } from 'vitest'
import {
  OMITTED_MQTT_PAYLOAD,
  REDACTED_MQTT_VALUE,
  redactMqttMessageRecord,
  redactMqttPayload,
} from './mqtt-message-redaction'

describe('MQTT message redaction', () => {
  it('redacts nested credential fields while preserving non-sensitive JSON data', () => {
    const payload = JSON.stringify({
      method: 'fileupload_start',
      data: {
        accessKeyId: 'camel-access-id',
        aws_access_key_id: 'aws-access-id',
        accessKeySecret: 'camel-secret-value',
        security_token: 'snake-token-value',
        nested: [{ client_secret: 'client-secret-value' }],
        objectKey: 'logs/device.zip',
      },
    })

    const redacted = JSON.parse(redactMqttPayload(payload))

    expect(redacted).toEqual({
      method: 'fileupload_start',
      data: {
        accessKeyId: REDACTED_MQTT_VALUE,
        aws_access_key_id: REDACTED_MQTT_VALUE,
        accessKeySecret: REDACTED_MQTT_VALUE,
        security_token: REDACTED_MQTT_VALUE,
        nested: [{ client_secret: REDACTED_MQTT_VALUE }],
        objectKey: 'logs/device.zip',
      },
    })
    expect(JSON.stringify(redacted)).not.toContain('camel-access-id')
    expect(JSON.stringify(redacted)).not.toContain('aws-access-id')
    expect(JSON.stringify(redacted)).not.toContain('camel-secret-value')
    expect(JSON.stringify(redacted)).not.toContain('snake-token-value')
    expect(JSON.stringify(redacted)).not.toContain('client-secret-value')
  })

  it('omits malformed sensitive payloads and leaves ordinary non-JSON payloads unchanged', () => {
    expect(redactMqttPayload('status=healthy')).toBe('status=healthy')
    expect(redactMqttPayload('access_key_secret=plain-secret&broken={')).toBe(OMITTED_MQTT_PAYLOAD)
    expect(redactMqttPayload('aws_access_key_id=plain-access-id&broken={')).toBe(OMITTED_MQTT_PAYLOAD)
    expect(redactMqttPayload('credentials.access_key_secret=path-secret')).toBe(OMITTED_MQTT_PAYLOAD)
    expect(redactMqttPayload('prefix-access_key_secret=dash-secret')).toBe(OMITTED_MQTT_PAYLOAD)
    expect(redactMqttPayload('<ns:AccessKeySecret>xml-secret</ns:AccessKeySecret>')).toBe(OMITTED_MQTT_PAYLOAD)
  })

  it('preserves unrelated JSON and text byte for byte', () => {
    const json = ' { "message": "password reset and token refresh documentation", "tokenCount": 2 } '
    const text = 'Operator note: password reset completed; security token documentation updated.'

    expect(redactMqttPayload(json)).toBe(json)
    expect(redactMqttPayload(text)).toBe(text)
  })

  it('redacts sensitive assignments embedded in otherwise non-sensitive JSON fields', () => {
    const payload = JSON.stringify({
      wrapper: 'access_key_secret=wrapped-secret',
      values: [
        'sts_token=wrapped-token',
        'https://example.com/log?X-Amz-Credential=wrapped-credential&X-Amz-Signature=wrapped-signature',
        'prefix|sts_token=pipe-token',
        'prefix/sts_token=slash-token',
        'credentials.access_key_secret=path-secret',
        '<ns:AccessKeySecret>xml-secret</ns:AccessKeySecret>',
        'password reset documentation',
      ],
      sts_token: 'direct-sts-token',
      'X-Amz-Credential': 'direct-amz-credential',
      'X-Amz-Signature': 'direct-amz-signature',
      'X-Oss-Credential': 'direct-oss-credential',
      'X-Oss-Signature': 'direct-oss-signature',
      explanatoryText: 'security token rotation documentation',
    })

    const redacted = JSON.parse(redactMqttPayload(payload))

    expect(redacted).toEqual({
      wrapper: REDACTED_MQTT_VALUE,
      values: [
        REDACTED_MQTT_VALUE,
        REDACTED_MQTT_VALUE,
        REDACTED_MQTT_VALUE,
        REDACTED_MQTT_VALUE,
        REDACTED_MQTT_VALUE,
        REDACTED_MQTT_VALUE,
        'password reset documentation',
      ],
      sts_token: REDACTED_MQTT_VALUE,
      'X-Amz-Credential': REDACTED_MQTT_VALUE,
      'X-Amz-Signature': REDACTED_MQTT_VALUE,
      'X-Oss-Credential': REDACTED_MQTT_VALUE,
      'X-Oss-Signature': REDACTED_MQTT_VALUE,
      explanatoryText: 'security token rotation documentation',
    })
    expect(JSON.stringify(redacted)).not.toContain('wrapped-secret')
    expect(JSON.stringify(redacted)).not.toContain('wrapped-token')
    expect(JSON.stringify(redacted)).not.toContain('wrapped-credential')
    expect(JSON.stringify(redacted)).not.toContain('wrapped-signature')
    expect(JSON.stringify(redacted)).not.toContain('pipe-token')
    expect(JSON.stringify(redacted)).not.toContain('slash-token')
    expect(JSON.stringify(redacted)).not.toContain('path-secret')
    expect(JSON.stringify(redacted)).not.toContain('xml-secret')
    expect(JSON.stringify(redacted)).not.toContain('direct-sts-token')
    expect(JSON.stringify(redacted)).not.toContain('direct-amz-credential')
    expect(JSON.stringify(redacted)).not.toContain('direct-amz-signature')
    expect(JSON.stringify(redacted)).not.toContain('direct-oss-credential')
    expect(JSON.stringify(redacted)).not.toContain('direct-oss-signature')
  })

  it('redacts credentials in MQTT properties and strips unknown record fields', () => {
    const record = redactMqttMessageRecord({
      id: 'message-1',
      profileId: 'profile-1',
      direction: 'in',
      topic: 'test/topic',
      payload: '{}',
      qos: 0,
      retain: false,
      timestamp: 1,
      size: 2,
      properties: {
        userProperties: {
          authorization: 'Bearer property-secret',
          securityToken: 'property-token',
          note: 'security_token=property-wrapped-token',
          'X-Amz-Credential': 'property-amz-credential',
          'X-Oss-Signature': 'property-oss-signature',
          safeNote: 'security token rotation documentation',
          traceId: 'trace-1',
        },
      },
      accessKeySecret: 'unknown-secret',
    } as Parameters<typeof redactMqttMessageRecord>[0] & { accessKeySecret: string })

    expect(record.properties).toEqual({
      userProperties: {
        authorization: REDACTED_MQTT_VALUE,
        securityToken: REDACTED_MQTT_VALUE,
        note: REDACTED_MQTT_VALUE,
        'X-Amz-Credential': REDACTED_MQTT_VALUE,
        'X-Oss-Signature': REDACTED_MQTT_VALUE,
        safeNote: 'security token rotation documentation',
        traceId: 'trace-1',
      },
    })
    expect(record).not.toHaveProperty('accessKeySecret')
  })
})
