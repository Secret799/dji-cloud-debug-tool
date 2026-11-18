import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, MqttMessageRecord } from '../../../shared/contracts'
import type { CommandTransaction } from '../lib/dji'
import {
  buildTraceRepublishPayload,
  DeviceTrace,
  traceRecordCategory,
  traceTransactionMatchesFocus,
} from './DeviceTrace'

const profile = {
  id: 'profile',
  name: '测试连接',
  devices: [{ id: 'device', name: '测试机场', sn: 'D1', type: 'dock' }],
} as ConnectionProfile

const records: MqttMessageRecord[] = [
  {
    id: 'osd-1', profileId: 'profile', direction: 'in', topic: 'thing/product/D1/osd',
    payload: JSON.stringify({ data: { latitude: 1 } }), qos: 0, retain: false, timestamp: 100, size: 40,
  },
  {
    id: 'osd-2', profileId: 'profile', direction: 'in', topic: 'thing/product/D1/osd',
    payload: JSON.stringify({ data: { latitude: 2 } }), qos: 0, retain: false, timestamp: 110, size: 40,
  },
  {
    id: 'service-1', profileId: 'profile', direction: 'out', topic: 'thing/product/D1/services',
    payload: JSON.stringify({ tid: 'tid-1', method: 'cover_open', data: {} }), qos: 1, retain: false, timestamp: 120, size: 60,
  },
]

const transaction = {
  tid: 'tid-1', bid: 'bid-1', method: 'cover_open', gatewaySn: 'D1', startedAt: 120,
  status: 'pending', request: records[2],
} satisfies CommandTransaction

describe('DeviceTrace', () => {
  it('renders report stream controls and collapses OSD records by default', () => {
    const markup = renderToStaticMarkup(
      <DeviceTrace
        profile={profile}
        status="connected"
        busy={false}
        records={records}
        transactions={[transaction]}
        selectedDeviceSn="D1"
        onPublish={async () => ({ ok: true })}
        onExport={async () => undefined}
        onClear={() => undefined}
      />,
    )

    expect(markup).toContain('报文流')
    expect(markup).toContain('事务')
    expect(markup).toContain('本设备')
    expect(markup).toContain('全部')
    expect(markup).toContain('只看失败')
    expect(markup).toContain('osd × 2，展开')
  })

  it('classifies trace topics and matches transaction focus by tid or bid', () => {
    expect(traceRecordCategory(records[0])).toBe('osd')
    expect(traceRecordCategory(records[2])).toBe('services')
    expect(traceTransactionMatchesFocus(transaction, { view: 'tx', tid: 'tid-1' })).toBe(true)
    expect(traceTransactionMatchesFocus(transaction, { view: 'tx', bid: 'bid-1' })).toBe(true)
    expect(traceTransactionMatchesFocus(transaction, { view: 'tx', tid: 'missing' })).toBe(false)
  })

  it('replaces a copied service tid before republishing', () => {
    const payload = buildTraceRepublishPayload(
      JSON.stringify({ tid: 'old-tid', bid: 'bid-1', method: 'cover_open', data: {} }),
      () => 'new-tid',
    )

    expect(JSON.parse(payload)).toMatchObject({ tid: 'new-tid', bid: 'bid-1', method: 'cover_open' })
  })
})
