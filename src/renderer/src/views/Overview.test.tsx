import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, MqttMessageRecord } from '../../../shared/contracts'
import type { CommandTransaction, DeviceActivity, DeviceTelemetry } from '../lib/dji'
import { createDefaultTelemetryLayout, reconcileTelemetryLayout } from '../lib/telemetry-layout'
import {
  CommandHistory,
  CommandResultCheckPage,
  DeviceEventWorkspace,
  formatElapsedTime,
  HmsPayloadDetails,
  JsonPayloadView,
  Overview,
  PayloadMessageList,
  PsdkChannelTabs,
  telemetryFieldMatchesSearch,
} from './Overview'

describe('elapsed time formatting', () => {
  it('uses seconds, minutes and hours at their respective boundaries', () => {
    expect(formatElapsedTime(-1_000)).toBe('0 秒前')
    expect(formatElapsedTime(59_999)).toBe('59 秒前')
    expect(formatElapsedTime(60_000)).toBe('1 分钟前')
    expect(formatElapsedTime(3_599_999)).toBe('59 分钟前')
    expect(formatElapsedTime(3_600_000)).toBe('1 小时前')
    expect(formatElapsedTime(3_960_000)).toBe('1 小时前')
  })
})

describe('telemetry field search', () => {
  it('matches localized display names and raw field paths', () => {
    expect(telemetryFieldMatchesSearch('environment_temperature', '环境温度', 'dock', true)).toBe(true)
    expect(telemetryFieldMatchesSearch('environment_temperature', 'TEMPERATURE', 'dock', true)).toBe(true)
    expect(telemetryFieldMatchesSearch('horizontal_speed', '水平 速度', 'aircraft')).toBe(true)
    expect(telemetryFieldMatchesSearch(
      'drone_battery_maintenance_info.batteries.0.temperature',
      '电池详细信息',
      'aircraft',
    )).toBe(true)
  })

  it('rejects fields that match neither the display name nor raw path', () => {
    expect(telemetryFieldMatchesSearch('environment_temperature', '电池电压', 'dock', true)).toBe(false)
  })
})

describe('CommandHistory request and response details', () => {
  it('shows complete request and response information for a command', () => {
    const request = {
      id: 'request', profileId: 'profile', direction: 'out', topic: 'thing/product/DOCK-1/services',
      payload: JSON.stringify({ tid: 'tid-complete', bid: 'bid-complete', method: 'cover_open', data: { force: true } }),
      qos: 1, retain: false, timestamp: 100, size: 100,
    } satisfies MqttMessageRecord
    const response = {
      id: 'response', profileId: 'profile', direction: 'in', topic: 'thing/product/DOCK-1/services_reply',
      payload: JSON.stringify({ tid: 'tid-complete', bid: 'bid-complete', data: { result: 0, detail: 'opened' } }),
      qos: 1, retain: false, timestamp: 145, size: 100,
    } satisfies MqttMessageRecord
    const transaction = {
      tid: 'tid-complete', bid: 'bid-complete', method: 'cover_open', gatewaySn: 'DOCK-1',
      startedAt: 100, finishedAt: 145, status: 'success', result: 0, request, response,
    } satisfies CommandTransaction

    const markup = renderToStaticMarkup(<CommandHistory transactions={[transaction]} />)

    expect(markup).toContain('<details class="command-history-item">')
    expect(markup).toContain('查看详情')
    expect(markup).not.toContain('<details class="command-history-item" open=""')
    expect(markup).toContain('发送信息')
    expect(markup).toContain('返回信息')
    expect(markup.match(/aria-label="复制 Topic"/g)).toHaveLength(2)
    expect(markup.match(/aria-label="复制 Payload"/g)).toHaveLength(2)
    expect(markup).toContain('thing/product/DOCK-1/services')
    expect(markup).toContain('thing/product/DOCK-1/services_reply')
    expect(markup).toContain('class="json-tree-key">&quot;force&quot;')
    expect(markup).toContain('class="json-tree-value boolean">true')
    expect(markup).toContain('class="json-tree-key">&quot;detail&quot;')
    expect(markup).toContain('class="json-tree-value string">&quot;opened&quot;')
    expect(markup).toContain('<dt>耗时</dt><dd>45 ms</dd>')
    expect(markup).toContain('<dt>结果码</dt><dd class="command-result-value"><span>0</span></dd>')
    expect(markup).not.toContain('核查')
  })

  it('offers workbook guidance on demand when a command reply has a non-zero result', () => {
    const request = {
      id: 'request-error', profileId: 'profile', direction: 'out', topic: 'thing/product/DOCK-1/services',
      payload: JSON.stringify({ tid: 'tid-error', method: 'flighttask_prepare', data: {} }),
      qos: 1, retain: false, timestamp: 100, size: 100,
    } satisfies MqttMessageRecord
    const response = {
      id: 'response-error', profileId: 'profile', direction: 'in', topic: 'thing/product/DOCK-1/services_reply',
      payload: JSON.stringify({ tid: 'tid-error', data: { result: 316031 } }),
      qos: 1, retain: false, timestamp: 145, size: 100,
    } satisfies MqttMessageRecord
    const transaction = {
      tid: 'tid-error', method: 'flighttask_prepare', gatewaySn: 'DOCK-1',
      startedAt: 100, finishedAt: 145, status: 'failed', result: 316031, request, response,
    } satisfies CommandTransaction

    const markup = renderToStaticMarkup(<CommandHistory transactions={[transaction]} />)

    expect(markup).toContain('<span>316031</span>')
    expect(markup).toContain('核查')
    expect(markup).not.toContain('结果码 316031 核查结果')
    expect(markup).not.toContain('设置返航模式失败')

    const checkMarkup = renderToStaticMarkup(
      <CommandResultCheckPage transaction={transaction} onBack={() => undefined} />,
    )
    expect(checkMarkup).toContain('返回最近指令')
    expect(checkMarkup).toContain('结果码 316031 核查结果')
    expect(checkMarkup).toContain('设置返航模式失败')
    expect(checkMarkup).toContain('2代机库下发任务需指定返航模式')
  })
})

describe('JSON payload tree', () => {
  it('parses JSON and exposes expandable object and array nodes', () => {
    const markup = renderToStaticMarkup(
      <JsonPayloadView payload={JSON.stringify({ data: { files: [{ size: 42 }] } })} />,
    )

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('aria-label="收起 JSON 根节点"')
    expect(markup).toContain('aria-label="展开 数组项 0"')
    expect(markup).toContain('class="json-tree-key">&quot;files&quot;')
    expect(markup).toContain('class="json-tree-index">[0]')
  })

  it('keeps invalid JSON available as scrollable raw text', () => {
    const markup = renderToStaticMarkup(<JsonPayloadView payload="not-json" />)

    expect(markup).toContain('command-payload-raw')
    expect(markup).toContain('not-json')
    expect(markup).not.toContain('role="tree"')
  })
})

describe('payload message list', () => {
  it('renders all integrated PSDK methods newest first and collapsed by default', () => {
    const activities = [
      {
        id: 'older', timestamp: 100, method: 'custom_data_transmission_from_psdk',
        label: 'PSDK 自定义数据', value: 'OLDER',
      },
      {
        id: 'latest', timestamp: 300, method: 'psdk_ui_resource_upload_result',
        label: 'PSDK UI 资源上传结果', value: 'LATEST',
      },
      {
        id: 'middle', timestamp: 200, method: 'psdk_floating_window_text',
        label: 'PSDK 浮窗文本', value: 'MIDDLE',
      },
    ].map(({ id, timestamp, method, label, value }) => ({
      record: {
        id,
        profileId: 'profile',
        direction: 'in' as const,
        topic: 'thing/product/DOCK-1/events',
        payload: JSON.stringify({ method, data: { psdk_index: 4, value } }),
        qos: 1 as const,
        retain: false,
        timestamp,
        size: 80,
      },
      method,
      kind: 'event' as const,
      label,
      knownMethod: true,
      psdkIndex: 4,
    })) satisfies DeviceActivity[]

    const markup = renderToStaticMarkup(<PayloadMessageList activities={activities} />)
    const tabsMarkup = renderToStaticMarkup(
      <PsdkChannelTabs
        activities={activities}
        activeMethod="psdk_floating_window_text"
        onSelect={() => undefined}
      />,
    )

    expect(markup.match(/class="payload-message-item"/g)).toHaveLength(3)
    expect(markup).not.toContain('class="payload-message-item" open=""')
    expect(markup).toContain('custom_data_transmission_from_psdk')
    expect(markup).toContain('psdk_floating_window_text')
    expect(markup).toContain('psdk_ui_resource_upload_result')
    expect(markup.indexOf('LATEST')).toBeLessThan(markup.indexOf('MIDDLE'))
    expect(markup.indexOf('MIDDLE')).toBeLessThan(markup.indexOf('OLDER'))
    expect(tabsMarkup).toContain('aria-label="PSDK 数据通道"')
    expect(tabsMarkup.match(/role="tab"/g)).toHaveLength(3)
    expect(tabsMarkup).toContain('aria-label="浮窗文本通道" aria-selected="true"')
    expect(tabsMarkup).toContain('aria-label="UI 资源通道" aria-selected="false"')
    expect(tabsMarkup).toContain('aria-label="自定义数据通道" aria-selected="false"')
  })
})

describe('device event workspace', () => {
  it('uses a type list on the left and shows only HMS message details on the right', () => {
    const hmsRecord = {
      id: 'hms-event', profileId: 'profile', direction: 'in', topic: 'thing/product/DOCK-1/events',
      payload: JSON.stringify({
        tid: 'hms-tid',
        bid: 'hms-bid',
        timestamp: 1654070968655,
        method: 'hms',
        data: {
          list: [
            {
              args: { component_index: 0, sensor_index: 1 },
              code: '0x16100016',
              device_type: '0-67-0',
              imminent: 1,
              in_the_sky: 0,
              level: 2,
              module: 3,
            },
            {
              args: { component_index: 1, sensor_index: 0 },
              code: '0x19113414',
              device_type: '3-2-0',
              imminent: 1,
              in_the_sky: 0,
              level: 1,
              module: 3,
            },
          ],
        },
      }),
      qos: 1, retain: false, timestamp: 200, size: 88,
    } satisfies MqttMessageRecord
    const drcRecord = {
      ...hmsRecord,
      id: 'drc-event',
      payload: JSON.stringify({ method: 'drc_status_notify', data: { result: 0 } }),
      timestamp: 100,
    } satisfies MqttMessageRecord
    const olderHmsRecord = {
      ...hmsRecord,
      id: 'hms-event-older',
      timestamp: 150,
    } satisfies MqttMessageRecord
    const activities = [
      { record: hmsRecord, method: 'hms', kind: 'event', label: '设备告警', knownMethod: true },
      { record: olderHmsRecord, method: 'hms', kind: 'event', label: '设备告警', knownMethod: true },
      { record: drcRecord, method: 'drc_status_notify', kind: 'event', label: 'DRC 状态通知', knownMethod: true },
    ] satisfies DeviceActivity[]

    const markup = renderToStaticMarkup(<DeviceEventWorkspace activities={activities} />)

    expect(markup).toContain('<h3>事件类型</h3>')
    expect(markup).not.toContain('<h3>消息列表</h3>')
    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('<strong>设备告警</strong><code>hms</code>')
    expect(markup.match(/class="event-message-list-row"/g)).toHaveLength(2)
    expect(markup.match(/class="event-message-detail-button"/g)).toHaveLength(2)
    expect(markup).not.toContain('class="event-message-detail"')
    expect(markup).not.toContain('DRC 状态通知')
    expect(markup).not.toContain('drc_status_notify')

    const detailMarkup = renderToStaticMarkup(<HmsPayloadDetails payload={hmsRecord.payload} />)
    expect(detailMarkup.match(/class="hms-alarm-item /g)).toHaveLength(2)
    expect(detailMarkup).toContain('class="hms-alarm-index">#1</span>')
    expect(detailMarkup).toContain('class="hms-alarm-index">#2</span>')
    expect(detailMarkup).toContain('class="hms-level-badge warning">警告</span>')
    expect(detailMarkup).toContain('无法起飞:飞行器未激活')
    expect(detailMarkup).toContain('电池温度过高')
    expect(detailMarkup).toContain('<dt>事件模块</dt><dd>HMS</dd>')
    expect(detailMarkup).toContain('<dt>飞行状态</dt><dd>在地上</dd>')
    expect(detailMarkup).toContain('<dt>组件索引</dt><dd>0</dd>')
    expect(detailMarkup).toContain('<dt>传感器索引</dt><dd>1</dd>')
    expect(detailMarkup).toContain('处理建议')
    expect(detailMarkup).toContain('原始 MQTT 报文')
  })
})

describe('Overview DJI field presentation', () => {
  it('keeps the command and camera centers mounted behind other workbench tabs', () => {
    const profile = {
      id: 'profile',
      name: 'Persistent playback',
      devices: [{ id: 'dock', name: '测试机场', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={[]}
        selectedDeviceSn="DOCK-1"
        records={[]}
        transactions={[]}
        onPublish={async () => ({ ok: true })}
      />,
    )

    expect(markup).toContain('class="persistent-command-center" hidden=""')
    expect(markup).toContain('class="persistent-camera-center" hidden=""')
  })

  it('does not restore a reported live state while MQTT is disconnected', () => {
    const profile = {
      id: 'profile', name: 'Offline camera',
      devices: [
        { id: 'dock', name: '测试机场', sn: 'DOCK-1', type: 'dock' },
        { id: 'aircraft', name: '测试飞机', sn: 'AIR-1', type: 'aircraft', parentSn: 'DOCK-1' },
      ],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile', sn: 'DOCK-1', type: 'dock', name: '测试机场', online: true,
      lastSeenAt: Date.now(), lastTopic: 'thing/product/DOCK-1/osd', state: {}, status: {},
      osd: {
        live_capacity: { device_list: [{
          sn: 'AIR-1', camera_list: [{ camera_index: '81-0-0', video_list: [{ video_index: 'wide-0', video_type: 'wide' }] }],
        }] },
        live_status: [{ video_id: 'AIR-1/81-0-0/wide-0', status: 1 }],
      },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview profile={profile} status="disconnected" telemetry={telemetry} selectedDeviceSn="DOCK-1" records={[]} transactions={[]} onPublish={async () => ({ ok: true })} />,
    )

    expect(markup).toContain('camera-stream-status ">离线档案</span>')
    expect(markup).not.toContain('camera-stream-status live">直播中</span>')
  })

  it('uses customized tab, field label and description from telemetry management', () => {
    const profile = {
      id: 'profile',
      name: 'Aircraft',
      devices: [{ id: 'aircraft', name: '飞机', sn: 'AIR-1', type: 'aircraft' }],
    } as ConnectionProfile
    const telemetryLayout = createDefaultTelemetryLayout()
    telemetryLayout.devices.aircraft.tabs[0].name = '自定义飞行页签'
    const field = telemetryLayout.devices.aircraft.fields.find((item) => item.key === 'horizontal_speed')
    if (!field) throw new Error('Missing horizontal speed field')
    field.label = '自定义水平速度'
    field.description = '用户编辑后的字段说明'
    expect(telemetryFieldMatchesSearch('horizontal_speed', '编辑后的字段', 'aircraft', false, field)).toBe(true)

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={[{
          profileId: 'profile', sn: 'AIR-1', type: 'aircraft', name: '飞机', online: true,
          lastSeenAt: Date.now(), lastTopic: 'thing/product/AIR-1/osd', status: {}, state: {},
          osd: { horizontal_speed: 4.2 },
        }]}
        selectedDeviceSn="AIR-1"
        records={[]}
        transactions={[]}
        telemetryLayout={telemetryLayout}
      />,
    )

    expect(markup).toContain('自定义飞行页签')
    expect(markup).toContain('自定义水平速度')
    expect(markup).toContain('aria-label="自定义水平速度字段详情"')
  })

  it('shows a formatted telemetry value together with its raw value', () => {
    const profile = {
      id: 'profile',
      name: 'Aircraft',
      devices: [{ id: 'aircraft', name: '飞机', sn: 'AIR-1', type: 'aircraft' }],
    } as ConnectionProfile
    const telemetryLayout = createDefaultTelemetryLayout()
    const field = {
      key: 'custom_timestamp',
      label: '采集时间',
      description: '',
      visible: true,
      formatter: 'datetime' as const,
    }
    telemetryLayout.devices.aircraft.fields.push(field)
    telemetryLayout.devices.aircraft.tabs[0].sections[0].fieldKeys.push(field.key)
    const timestamp = 1_700_000_000_000

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={[{
          profileId: 'profile', sn: 'AIR-1', type: 'aircraft', name: '飞机', online: true,
          lastSeenAt: Date.now(), lastTopic: 'thing/product/AIR-1/osd', status: {}, state: {},
          osd: { custom_timestamp: timestamp },
        }]}
        selectedDeviceSn="AIR-1"
        records={[]}
        transactions={[]}
        telemetryLayout={telemetryLayout}
      />,
    )

    expect(markup).toContain('采集时间')
    expect(markup).toContain('telemetry-formatted-raw')
    expect(markup).toContain(`<span>原始值</span><code>${timestamp}</code>`)
    expect(markup).not.toContain(`<strong>${timestamp}</strong>`)
  })

  it('shows an unknown vendor when the product enum is not registered', () => {
    const profile = {
      id: 'profile',
      name: 'SuperDock',
      devices: [{
        id: 'dock',
        name: '草莓机场',
        sn: 'SUPERDOCK-1',
        type: 'dock',
        provider: 'superdock',
        dockModel: 's24m4',
      }],
    } as ConnectionProfile
    const telemetryLayout = createDefaultTelemetryLayout()
    const telemetry = [{
      profileId: 'profile',
      sn: 'SUPERDOCK-1',
      type: 'dock',
      provider: 'dji',
      name: '草莓机场',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/SUPERDOCK-1/state',
      identity: { domain: '3', productType: 88999, productSubType: 0 },
      status: {},
      state: { air_transfer_enable: true },
      osd: {},
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="SUPERDOCK-1"
        records={[]}
        transactions={[]}
        telemetryLayout={telemetryLayout}
        onPublish={async () => ({ ok: true })}
      />,
    )

    expect(markup).toContain('<span>设备厂商</span><strong>未知</strong>')
    expect(markup).toContain('<span>设备型号</span><strong title="3-88999-0">S24M4</strong>')
    expect(markup).toContain('air_transfer_enable')
    expect(markup).not.toContain('aria-label="设置空中回传（无人机到机场）"')
    const deviceTabs = markup.match(/<nav class="device-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(deviceTabs).not.toContain('<span>控制中心</span>')
    expect(deviceTabs).not.toContain('<span>负载</span>')
    expect(deviceTabs).not.toContain('<span>远程日志</span>')
    expect(deviceTabs).not.toContain('<span>固件升级</span>')
    expect(markup).not.toContain('class="control-center-workspace"')
  })

  it('inherits SuperDock workspace restrictions through a configured parent gateway', () => {
    const profile = {
      id: 'profile',
      name: 'SuperDock aircraft',
      devices: [
        {
          id: 'dock', name: '草莓机场', sn: 'SUPERDOCK-1', type: 'dock',
          provider: 'superdock', dockModel: 's24m4',
        },
        {
          id: 'aircraft', name: 'DJI 飞行器', sn: 'AIR-1', type: 'aircraft',
          parentSn: 'SUPERDOCK-1',
        },
      ],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'AIR-1',
      type: 'aircraft',
      name: 'DJI 飞行器',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/AIR-1/osd',
      identity: { domain: '0', productType: 91, productSubType: 1 },
      status: {},
      state: {},
      osd: { horizontal_speed: 6.5 },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="AIR-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('<span>设备厂商</span><strong>DJI</strong>')
    expect(markup).toContain('<span>设备型号</span><strong title="0-91-1">DJI Matrice 3TD</strong>')
    expect(markup).toContain('aria-label="水平速度字段详情"')
    const deviceTabs = markup.match(/<nav class="device-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(deviceTabs).not.toContain('<span>固件升级</span>')
  })

  it('uses a SuperDock product enum even when the configured provider defaults to DJI', () => {
    const profile = {
      id: 'profile',
      name: 'Mixed provider',
      devices: [{
        id: 'dock', name: '草莓机场', sn: 'SUPERDOCK-1', type: 'dock', dockModel: 'other',
      }],
    } as ConnectionProfile
    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={[{
          profileId: 'profile', sn: 'SUPERDOCK-1', type: 'dock', name: '草莓机场', online: true,
          lastSeenAt: Date.now(), lastTopic: 'sys/product/SUPERDOCK-1/status',
          identity: { domain: '3', productType: 88105, productSubType: 0 },
          status: {}, state: {}, osd: {},
        }]}
        selectedDeviceSn="SUPERDOCK-1"
        records={[]}
        transactions={[]}
        onPublish={async () => ({ ok: true })}
      />,
    )

    expect(markup).toContain('<span>设备厂商</span><strong>草莓创新</strong>')
    expect(markup).toContain('<span>设备型号</span><strong title="3-88105-0">S25M400</strong>')
    const deviceTabs = markup.match(/<nav class="device-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(deviceTabs).toContain('<span>控制中心</span>')
    expect(deviceTabs).toContain('<span>负载</span>')
    const controlCenterTabs = markup.match(/<nav class="control-center-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(controlCenterTabs).not.toContain('<span>远程日志</span>')
    expect(controlCenterTabs).not.toContain('<span>固件升级</span>')
    expect(markup).toContain('机场推杆')
    expect(markup).not.toContain('机场补光灯')
  })

  it('inherits SuperDock workspace restrictions through a runtime gateway', () => {
    const profile = { id: 'profile', name: 'Discovered aircraft', devices: [] } as unknown as ConnectionProfile
    const telemetry = [
      {
        profileId: 'profile',
        sn: 'AIR-1',
        gatewaySn: 'SUPERDOCK-1',
        type: 'aircraft',
        provider: 'dji',
        name: 'DJI 飞行器',
        online: true,
        lastSeenAt: Date.now(),
        lastTopic: 'thing/product/AIR-1/osd',
        identity: { domain: '0', productType: 91, productSubType: 1 },
        status: {},
        state: {},
        osd: { horizontal_speed: 6.5 },
      },
      {
        profileId: 'profile',
        sn: 'SUPERDOCK-1',
        type: 'dock',
        provider: 'superdock',
        name: '运行时草莓机场',
        online: true,
        lastSeenAt: Date.now(),
        lastTopic: 'sys/product/SUPERDOCK-1/status',
        status: {},
        state: {},
        osd: {},
      },
    ] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="AIR-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('<span>设备厂商</span><strong>DJI</strong>')
    expect(markup).toContain('aria-label="水平速度字段详情"')
    const deviceTabs = markup.match(/<nav class="device-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(deviceTabs).not.toContain('<span>固件升级</span>')
  })

  it('keeps a genuinely customized field label over SuperDock metadata', () => {
    const profile = {
      id: 'profile',
      name: 'SuperDock',
      devices: [{
        id: 'dock', name: '草莓机场', sn: 'SUPERDOCK-1', type: 'dock',
        provider: 'superdock', dockModel: 's24m4',
      }],
    } as ConnectionProfile
    const telemetryLayout = createDefaultTelemetryLayout()
    const field = telemetryLayout.devices.dock.fields.find((item) => item.key === 'air_transfer_enable')
    if (!field) throw new Error('Missing air transfer field')
    field.label = '现场回传开关'
    field.description = '用户维护的回传控制说明'
    expect(telemetryFieldMatchesSearch(
      'air_transfer_enable',
      '现场回传',
      'dock',
      false,
      field,
      false,
      true,
    )).toBe(true)

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={[{
          profileId: 'profile', sn: 'SUPERDOCK-1', type: 'dock', provider: 'superdock', name: '草莓机场',
          online: true, lastSeenAt: Date.now(), lastTopic: 'thing/product/SUPERDOCK-1/state',
          status: {}, state: { air_transfer_enable: true }, osd: {},
        }]}
        selectedDeviceSn="SUPERDOCK-1"
        records={[]}
        transactions={[]}
        telemetryLayout={telemetryLayout}
      />,
    )

    expect(markup).toContain('现场回传开关')
    expect(markup).toContain('aria-label="现场回传开关字段详情"')
    expect(markup).not.toContain('aria-label="空中回传（无人机到机场）字段详情"')
  })

  it('falls back from runtime provider to topology provider when no device is configured', () => {
    const profile = { id: 'profile', name: 'Discovery', devices: [] } as unknown as ConnectionProfile
    const runtimeProviderMarkup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={[{
          profileId: 'profile', sn: 'RUNTIME-1', type: 'dock', provider: 'superdock', name: '运行时机场',
          online: true, lastSeenAt: Date.now(), lastTopic: 'sys/product/RUNTIME-1/status',
          identity: { domain: '3', productType: 2, productSubType: 0 },
          status: {}, state: {}, osd: {},
        }]}
        selectedDeviceSn="RUNTIME-1"
        records={[]}
        transactions={[]}
      />,
    )
    const topologyProviderMarkup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={[{
          profileId: 'profile', sn: 'TOPOLOGY-1', type: 'dock', name: '拓扑机场',
          online: true, lastSeenAt: Date.now(), lastTopic: 'sys/product/TOPOLOGY-1/status',
          identity: { domain: '3', productType: 88099, productSubType: 0 },
          status: {}, state: {}, osd: {},
        }]}
        selectedDeviceSn="TOPOLOGY-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(runtimeProviderMarkup).toContain('<span>设备厂商</span><strong>DJI</strong>')
    expect(runtimeProviderMarkup).toContain('<span>设备型号</span><strong title="3-2-0">DJI Dock 2</strong>')
    expect(runtimeProviderMarkup).not.toContain('<span>控制中心</span>')
    expect(runtimeProviderMarkup).not.toContain('class="control-center-workspace"')
    expect(runtimeProviderMarkup).not.toContain('class="persistent-command-center"')
    expect(topologyProviderMarkup).toContain('<span>设备厂商</span><strong>草莓创新</strong>')
    expect(topologyProviderMarkup).toContain('S2301')
  })

  it('uses device-type-specific status copy in the summary', () => {
    const profile = {
      id: 'profile',
      name: 'Pilot',
      devices: [{ id: 'pilot', name: '现场遥控器', sn: 'RC-1', type: 'pilot' }],
    } as ConnectionProfile

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={[]}
        selectedDeviceSn="RC-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('当前所选遥控器')
    expect(markup).toContain('遥控器离线')
    expect(markup).toContain('DJI Pilot')
    expect(markup).toContain('<span>固件版本</span><strong title="尚未上报">尚未上报</strong>')
    expect(markup).not.toContain('切换设备')
    const controlCenterTabs = markup.match(/<nav class="control-center-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(controlCenterTabs).toContain('<span>设备控制</span>')
    expect(controlCenterTabs).not.toContain('<span>远程日志</span>')
    expect(controlCenterTabs).not.toContain('<span>固件升级</span>')
  })

  it('maps the aircraft model key instead of displaying a payload index', () => {
    const profile = {
      id: 'profile',
      name: 'Aircraft',
      devices: [{ id: 'aircraft', name: '库内飞机', sn: 'AIR-1', type: 'aircraft', parentSn: 'DOCK-1' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'AIR-1',
      gatewaySn: 'DOCK-1',
      type: 'aircraft',
      name: '库内飞机',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/AIR-1/osd',
      status: { device_model_key: '0-91-1' },
      state: {},
      osd: {
        payload_index: '81-0-0',
        environment_temperature: 28,
        horizontal_speed: 6.5,
        drone_charge_state: { state: 1, capacity_percent: 57 },
        drone_battery_maintenance_info: {
          maintenance_state: 0,
          batteries: [{ index: 0, capacity_percent: 57, temperature: 43.7 }],
        },
        maintain_status: {
          maintain_status_array: [{ state: 0, last_maintain_type: 1, last_maintain_time: 0 }],
        },
      },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="AIR-1"
        records={[{
          id: 'payload-1',
          profileId: 'profile',
          direction: 'in',
          topic: 'thing/product/DOCK-1/events',
          payload: JSON.stringify({
            method: 'custom_data_transmission_from_psdk',
            data: { psdk_index: 2, value: 'aircraft payload' },
          }),
          qos: 1,
          retain: false,
          timestamp: Date.now(),
          size: 0,
        }]}
        transactions={[]}
      />,
    )
    expect(markup).toContain('<span>设备型号</span><strong title="0-91-1">DJI Matrice 3TD</strong>')
    expect(markup).not.toContain('所属网关')
    expect(markup).not.toContain('metric-strip')
    expect(markup).not.toContain('环境温度')
    expect(markup).toContain('飞行信息')
    expect(markup).toContain('位置、姿态与速度')
    expect(markup).toContain('水平速度')
    expect(markup).toContain('6.5 m/s')
    expect(markup).toContain('aria-label="水平速度字段详情"')
    expect(markup).toContain('负载编号')
    expect(markup).toContain('保养记录')
    expect(markup).toContain('设备信息')
    expect(markup).toContain('电池与充电')
    expect(markup).toContain('drone_battery_maintenance_info.batteries.0.temperature')
    expect(markup).toContain('运维信息')
    expect(markup).toContain('maintain_status.maintain_status_array.0.last_maintain_type')
    expect(markup).toContain('负载与云台')
    const deviceTabs = markup.match(/<nav class="device-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(deviceTabs).not.toContain('信息分类')
    expect(deviceTabs).toContain('<span>遥测</span>')
    expect(deviceTabs).not.toContain('<span>控制中心</span>')
    expect(deviceTabs).toContain('<span>MQTT 消息</span>')
    expect(deviceTabs).not.toContain('<span>负载</span>')
    expect(deviceTabs).not.toContain('<span>固件升级</span>')
    expect(deviceTabs).not.toContain('<span>事件</span>')
    expect(deviceTabs).not.toContain('<span>最近指令</span>')
  })

  it('uses Dock 3 topology identity instead of stale configured Dock 2 metadata', () => {
    const profile = {
      id: 'profile',
      name: 'Dock 3',
      devices: [{ id: 'dock', name: '现场机场', sn: 'DOCK-3', type: 'dock', dockModel: 'dock2' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-3',
      type: 'dock',
      name: '现场机场',
      online: false,
      lastSeenAt: Date.now(),
      lastTopic: 'sys/product/DOCK-3/status',
      identity: { domain: '3', productType: 3, productSubType: 0, thingVersion: '1.2.0' },
      status: {},
      state: { firmware_version: '01.02.0300' },
      osd: { cover_state: 1 },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="DOCK-3"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('<span>设备型号</span><strong title="3-3-0">DJI Dock 3</strong>')
    expect(markup).toContain('<span>产品枚举</span><strong title="3-3-0">3-3-0</strong>')
    expect(markup).toContain('<span>物模型 / 通道</span><strong title="v1.2.0">v1.2.0</strong>')
    expect(markup).toContain('<span>固件版本</span><strong title="01.02.0300">01.02.0300</strong>')
    expect(markup.indexOf('<span>固件版本</span>')).toBeLessThan(markup.indexOf('<span>最后上报</span>'))
    expect(markup).toContain('机场离线')
    expect(markup).not.toContain('field-help-button')
    expect(markup).not.toContain('打开 (1)')
  })

  it('offers property setting for read/write Dock 3 telemetry fields', () => {
    const profile = {
      id: 'profile',
      name: 'Dock 3',
      devices: [{ id: 'dock', name: '现场机场', sn: 'DOCK-3', type: 'dock', dockModel: 'dock3' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-3',
      type: 'dock',
      name: '现场机场',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/DOCK-3/state',
      status: {},
      state: { silent_mode: 1, cover_state: 0 },
      osd: {},
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="DOCK-3"
        records={[]}
        transactions={[]}
        onPublish={async () => ({ ok: true })}
      />,
    )

    expect(markup).toContain('静音模式 (1)')
    expect(markup).toContain('aria-label="设置机场静音模式"')
    expect(markup.match(/telemetry-property-set-button/g)).toHaveLength(1)
    expect(markup).not.toContain('aria-label="设置舱盖状态"')
  })

  it('offers aircraft property setting through its parent gateway', () => {
    const profile = {
      id: 'profile',
      name: 'Aircraft',
      devices: [
        { id: 'dock', name: '机场', sn: 'DOCK-1', type: 'dock', dockModel: 'dock3' },
        { id: 'aircraft', name: '飞机', sn: 'AIR-1', type: 'aircraft', parentSn: 'DOCK-1' },
      ],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'AIR-1',
      gatewaySn: 'DOCK-1',
      type: 'aircraft',
      name: '飞机',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/AIR-1/osd',
      status: {},
      state: {},
      osd: { height_limit: 120, mode_code: 3 },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="AIR-1"
        records={[]}
        transactions={[]}
        onPublish={async () => ({ ok: true })}
      />,
    )

    expect(markup).toContain('aria-label="设置飞行器限高"')
    expect(markup.match(/telemetry-property-set-button/g)).toHaveLength(1)
    expect(markup).not.toContain('aria-label="设置飞行器状态"')
  })

  it('offers property setting for an enabled custom telemetry field', () => {
    const profile = {
      id: 'profile',
      name: 'Pilot',
      devices: [{ id: 'pilot', name: '遥控器', sn: 'RC-1', type: 'pilot' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'RC-1',
      type: 'pilot',
      name: '遥控器',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/RC-1/state',
      status: {},
      state: { custom_level: 1 },
      osd: {},
    }] satisfies DeviceTelemetry[]
    const telemetryLayout = reconcileTelemetryLayout(createDefaultTelemetryLayout(), telemetry)
    const field = telemetryLayout.devices.pilot.fields.find((item) => item.key === 'custom_level')
    if (!field) throw new Error('Missing custom telemetry field')
    field.label = '自定义等级'
    field.propertySetting = {
      enabled: true,
      path: 'custom_control.level',
      type: 'enum_int',
      constraint: '{"0":"关闭","1":"开启"}',
    }

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="RC-1"
        records={[]}
        transactions={[]}
        telemetryLayout={telemetryLayout}
        onPublish={async () => ({ ok: true })}
      />,
    )

    expect(markup).toContain('开启 (1)')
    expect(markup).toContain('aria-label="设置自定义等级"')
  })

  it('renders every received Dock 2 field with official labels and help details', () => {
    const extraFields = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [`extra_${String(index).padStart(2, '0')}`, index]),
    )
    const profile = {
      id: 'profile',
      name: 'Smoke',
      devices: [{ id: 'dock', name: '测试机场', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-1',
      type: 'dock',
      name: '测试机场',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/DOCK-1/osd',
      status: {},
      state: {},
      osd: {
        cover_state: 1,
        network_state: { type: 2, rate: 12.5 },
        drone_battery_maintenance_info: {
          batteries: [{ capacity_percent: 88, temperature: 31.5 }],
        },
        ...extraFields,
      },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="DOCK-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('舱盖状态')
    expect(markup).toContain('打开 (1)')
    expect(markup).toContain('网络速率')
    expect(markup).toContain('12.5 KB/s')
    expect(markup).not.toContain('drone_battery_maintenance_info')
    expect(markup).not.toContain('88 %')
    expect(markup).not.toContain('31.5 °C')
    expect(markup).toContain('机场在线')
    expect(markup).toContain('DJI Dock 2')
    expect(markup).toContain('控制中心')
    const deviceTabs = markup.match(/<nav class="device-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(deviceTabs).not.toContain('<span>远程日志</span>')
    expect(deviceTabs).not.toContain('<span>固件升级</span>')
    expect(deviceTabs).toContain('<span>负载</span><small>0</small>')
    expect(deviceTabs.indexOf('<span>负载</span>')).toBeGreaterThan(deviceTabs.indexOf('<span>控制中心</span>'))
    const controlCenterTabs = markup.match(/<nav class="control-center-tabs"[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(controlCenterTabs).toContain('<span>设备控制</span>')
    expect(controlCenterTabs).toContain('<span>远程日志</span>')
    expect(controlCenterTabs).toContain('<span>固件升级</span>')
    expect(markup.match(/最近指令/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="舱盖状态字段详情"')
    expect(markup).toContain('aria-label="搜索遥测字段"')
    expect(markup).toContain('placeholder="搜索名称或原始字段名"')
    expect(markup.match(/field-help-button/g)).toHaveLength(48)
  })

  it('groups every OSD and state field while excluding gateway status fields', () => {
    const profile = {
      id: 'profile',
      name: 'Grouped telemetry',
      devices: [{ id: 'dock', name: '测试机场', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-1',
      type: 'dock',
      name: '测试机场',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/DOCK-1/state',
      status: { status_only_field: 'must-not-render' },
      state: { mode_code: 2, cover_state: 1 },
      osd: {
        network_state: { type: 2 },
        alternate_land_point: {
          longitude: 108.8026,
          latitude: 34.312,
          safe_land_height: 30,
          is_configured: 1,
        },
        battery: { capacity_percent: 75 },
        environment_temperature: 26,
        gimbal_yaw: 10,
        maintain_status: {
          maintain_status_array: [{
            state: 0,
            last_maintain_type: 17,
            last_maintain_time: 0,
            last_maintain_work_sorties: 0,
          }],
        },
      },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="DOCK-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('运行信息')
    expect(markup).toContain('设备信息')
    expect(markup).toContain('运行与任务状态')
    expect(markup).toContain('供电与备用电池')
    expect(markup).toContain('环境数据')
    expect(markup).toContain('网络与通信')
    expect(markup).toContain('地理位置与备降')
    expect(markup).toContain('>负载</span>')
    expect(markup).toContain('负载与云台')
    expect(markup).toContain('机场设备')
    expect(markup).toContain('运维信息')
    expect(markup).toContain('保养信息')
    expect(markup).not.toContain('实时遥测')
    expect(markup).not.toContain('OSD 4')
    expect(markup).not.toContain('STATE 2')
    expect(markup).toContain('aria-label="遥测数据分类"')
    expect(markup).toContain('aria-orientation="vertical"')
    expect(markup).toContain('aria-labelledby="telemetry-tab-device"')
    expect(markup).toContain('aria-label="设备信息二级分类"')
    expect(markup).toContain('class="telemetry-section-tabs"')
    expect(markup).toMatch(/id="telemetry-section-panel-device-environment"[^>]*hidden=""/)
    expect(markup).toMatch(/id="telemetry-panel-device"[^>]*role="tabpanel"[^>]*hidden=""/)
    expect(markup).toMatch(/id="telemetry-panel-maintenance"[^>]*hidden="">[\s\S]*?maintain_status\.maintain_status_array\.0\.state/)
    expect(markup).toContain('network_state.type')
    expect(markup).toMatch(/id="telemetry-section-panel-operation-safety"[\s\S]*?alternate_land_point\.is_configured/)
    expect(markup).toContain('mode_code')
    expect(markup).not.toContain('status_only_field')
  })

  it('expands primitive and object arrays into separate rows and item groups', () => {
    const profile = {
      id: 'profile',
      name: 'Array telemetry',
      devices: [{ id: 'dock', name: '测试机场', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-1',
      type: 'dock',
      name: '测试机场',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/DOCK-1/osd',
      status: {},
      state: {},
      osd: {
        supported_modes: ['wide', 'zoom'],
        empty_items: [],
        maintain_status: {
          maintain_status_array: [
            { state: 0, last_maintain_type: 1 },
            { state: 1, last_maintain_type: 17 },
          ],
        },
      },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="DOCK-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup.match(/data-array-path="supported_modes"/g)).toHaveLength(1)
    expect(markup).toContain('supported_modes.0')
    expect(markup).toContain('supported_modes.1')
    expect(markup).toContain('<strong>wide</strong>')
    expect(markup).toContain('<strong>zoom</strong>')
    expect(markup).not.toContain('[&quot;wide&quot;,&quot;zoom&quot;]')
    expect(markup).toContain('<strong>空数组</strong>')
    expect(markup.match(/data-array-path="maintain_status\.maintain_status_array"/g)).toHaveLength(1)
    expect(markup.match(/class="telemetry-array-item"/g)).toHaveLength(2)
    expect(markup).toContain('<span>第 1 项</span>')
    expect(markup).toContain('<span>第 2 项</span>')
    expect(markup).toContain('maintain_status.maintain_status_array.1.last_maintain_type')
  })

  it('preserves the parent-child hierarchy of nested telemetry arrays', () => {
    const profile = {
      id: 'profile',
      name: 'Nested array telemetry',
      devices: [{ id: 'dock', name: '测试机场', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-1',
      type: 'dock',
      name: '测试机场',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/DOCK-1/osd',
      status: {},
      state: {},
      osd: {
        live_capacity: {
          device_list: [{
            sn: 'AIR-1',
            camera_list: [{
              camera_index: '81-0-0',
              video_list: [{ video_index: 'wide-0', video_type: 'wide' }],
            }],
          }],
        },
      },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="connected"
        telemetry={telemetry}
        selectedDeviceSn="DOCK-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('data-array-path="live_capacity.device_list" data-array-depth="0"')
    expect(markup).toContain('data-array-path="live_capacity.device_list.0.camera_list" data-parent-array-path="live_capacity.device_list" data-array-depth="1"')
    expect(markup).toContain('data-array-path="live_capacity.device_list.0.camera_list.0.video_list" data-parent-array-path="live_capacity.device_list.0.camera_list" data-array-depth="2"')
    expect(markup).toContain('live_capacity.device_list.0.camera_list.0.video_list.0.video_index')
  })

  it('does not report a device as online when MQTT is disconnected', () => {
    const profile = {
      id: 'profile',
      name: 'Dock 2',
      devices: [{ id: 'dock', name: '测试机场', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-1',
      type: 'dock',
      name: '测试机场',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/DOCK-1/osd',
      status: {},
      state: {},
      osd: { environment_temperature: 30 },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        status="disconnected"
        telemetry={telemetry}
        selectedDeviceSn="DOCK-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('机场离线')
    expect(markup).not.toContain('历史遥测')
    expect(markup).not.toContain('已停止更新')
    expect(markup).not.toContain('机场在线')
  })

  it('does not apply Dock 2 metadata to other dock models', () => {
    const profile = {
      id: 'profile',
      name: 'Other dock',
      devices: [{ id: 'dock', name: '其他机场', sn: 'DOCK-1', type: 'dock', dockModel: 'other' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-1',
      type: 'dock',
      name: '其他机场',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/DOCK-1/osd',
      status: {},
      state: {},
      osd: { cover_state: 1 },
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={telemetry}
        selectedDeviceSn="DOCK-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup).toContain('<strong>1</strong>')
    expect(markup).not.toContain('field-help-button')
    expect(markup).not.toContain('打开 (1)')
  })

  it('caps extreme telemetry payloads before creating thousands of rows', () => {
    const profile = {
      id: 'profile',
      name: 'Dock 2',
      devices: [{ id: 'dock', name: 'Dock 2', sn: 'DOCK-1', type: 'dock', dockModel: 'dock2' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile',
      sn: 'DOCK-1',
      type: 'dock',
      name: 'Dock 2',
      online: true,
      lastSeenAt: Date.now(),
      lastTopic: 'thing/product/DOCK-1/osd',
      status: {},
      state: {},
      osd: Object.fromEntries(Array.from({ length: 550 }, (_, index) => [`field_${index}`, index])),
    }] satisfies DeviceTelemetry[]

    const markup = renderToStaticMarkup(
      <Overview
        profile={profile}
        telemetry={telemetry}
        selectedDeviceSn="DOCK-1"
        records={[]}
        transactions={[]}
      />,
    )

    expect(markup.match(/class="telemetry-row"/g)).toHaveLength(500)
    expect(markup).not.toContain('已达 500 项显示上限')
    expect(markup).not.toContain('field_549')
  })
})
