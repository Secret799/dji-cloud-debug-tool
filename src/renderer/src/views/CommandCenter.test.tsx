import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ConnectionProfile, MediaServerProfile } from '../../../shared/contracts'
import { DJI_COMMANDS, type DeviceTelemetry } from '../lib/dji'
import { buildMediaEndpoints } from '../lib/media'
import {
  isValidSuperDockLtePhone,
  isValidSuperDockLteVerificationCode,
} from '../lib/superdock'
import { isCameraLiveQualityLocked, selectCameraPushEndpoint } from './CameraCenter'
import { CommandCenter, superDockLteAuthenticationStatus } from './CommandCenter'

const renderCommandCenter = (
  profile: ConnectionProfile,
  selectedDeviceSn: string,
  telemetry: DeviceTelemetry[] = [],
): string =>
  renderToStaticMarkup(
    <CommandCenter
      profile={profile}
      status="connected"
      busy={false}
      selectedDeviceSn={selectedDeviceSn}
      telemetry={telemetry}
      onPublish={async () => ({ ok: true })}
    />,
  )

const renderFlightCenter = (
  profile: ConnectionProfile,
  telemetry: DeviceTelemetry[],
): string =>
  renderToStaticMarkup(
    <CommandCenter
      profile={profile}
      status="connected"
      busy={false}
      selectedDeviceSn="DOCK-1"
      telemetry={telemetry}
      onPublish={async () => ({ ok: true })}
      allowedCategories={['flight']}
    />,
  )

describe('SuperDock live compatibility', () => {
  const mediaServer = {
    id: 'easy-media',
    name: 'EasyMedia',
    kind: 'remote-easymedia',
    host: 'media.example.com',
    apiProtocol: 'https',
    apiPort: 443,
    httpProtocol: 'https',
    httpPort: 443,
    rtmpPort: 1935,
    rtspPort: 0,
    webrtcPort: 8000,
    secret: '',
    createdAt: 1,
    updatedAt: 1,
  } satisfies MediaServerProfile
  const endpoints = buildMediaEndpoints(mediaServer, 'live', 'superdock-camera')

  it('selects WHIP rather than a raw WebRTC endpoint', () => {
    expect(selectCameraPushEndpoint('superdock', mediaServer.kind, endpoints, 'webrtc')).toBe(endpoints.whip)
    expect(selectCameraPushEndpoint('superdock', mediaServer.kind, endpoints, 'rtmp')).toBe(endpoints.rtmp)
  })

  it('locks live quality only for the SuperDock airport camera', () => {
    expect(isCameraLiveQualityLocked('superdock', 'dock', true)).toBe(true)
    expect(isCameraLiveQualityLocked('superdock', 'aircraft', true)).toBe(false)
    expect(isCameraLiveQualityLocked('superdock', 'dock', false)).toBe(false)
    expect(isCameraLiveQualityLocked('dji', 'dock', true)).toBe(false)
  })
})

describe('CommandCenter gateway context', () => {
  it('uses the selected gateway device without asking the user to select it again', () => {
    const profile = {
      id: 'profile',
      devices: [{ id: 'dock', name: '能飞外侧二代机场', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile

    const markup = renderCommandCenter(profile, 'DOCK-1')

    expect(markup).not.toContain('网关设备')
    expect(markup).toContain('thing/product/DOCK-1/services')
    expect(markup).not.toContain('请求响应记录')
  })

  it('uses the selected aircraft parent gateway without showing a selector', () => {
    const profile = {
      id: 'profile',
      devices: [
        { id: 'dock', name: '二代机场', sn: 'DOCK-1', type: 'dock' },
        { id: 'aircraft', name: '已发现飞机', sn: 'AIR-1', type: 'aircraft', parentSn: 'DOCK-1' },
      ],
    } as ConnectionProfile

    const markup = renderCommandCenter(profile, 'AIR-1')

    expect(markup).not.toContain('网关设备')
    expect(markup).toContain('thing/product/DOCK-1/services')
  })

  it('asks for a gateway only when the selected device relationship is ambiguous', () => {
    const profile = {
      id: 'profile',
      devices: [
        { id: 'dock-1', name: '一号机场', sn: 'DOCK-1', type: 'dock' },
        { id: 'dock-2', name: '二号机场', sn: 'DOCK-2', type: 'dock' },
        { id: 'aircraft', name: '未关联飞机', sn: 'AIR-1', type: 'aircraft' },
      ],
    } as ConnectionProfile

    const markup = renderCommandCenter(profile, 'AIR-1')

    expect(markup).toContain('网关设备')
    expect(markup).toContain('一号机场 · DOCK-1')
    expect(markup).toContain('二号机场 · DOCK-2')
  })
})

describe('CommandCenter remote debugging category', () => {
  it('uses the parameterless SuperDock RTK workflow', () => {
    const profile = {
      id: 'profile',
      devices: [
        {
          id: 'superdock',
          name: 'SuperDock S24M4',
          sn: 'SB-001',
          type: 'dock',
          provider: 'superdock',
          dockModel: 's24m4',
        },
        { id: 'aircraft', name: '库内飞机', sn: 'AIR-001', type: 'aircraft', parentSn: 'SB-001' },
      ],
    } as ConnectionProfile
    const telemetry = [
      {
        profileId: 'profile', sn: 'SB-001', type: 'dock', provider: 'superdock', name: 'SuperDock S24M4', online: true,
        lastSeenAt: Date.now(), lastTopic: 'thing/product/SB-001/osd', status: {}, state: {},
        osd: { mode_code: 2, putter_state: 0, wireless_link: { link_workmode: 1 } },
      },
      {
        profileId: 'profile', sn: 'AIR-001', gatewaySn: 'SB-001', type: 'aircraft', name: '库内飞机', online: true,
        lastSeenAt: Date.now(), lastTopic: 'thing/product/AIR-001/state', status: {}, osd: {},
        state: { dongle_infos: [{
          sim_phone_area_code: '86',
          sim_phone_number: '13300000000',
          sim_remaining_time: 120,
          sim_is_authentication_available: false,
          sim_link_workmode: true,
        }] },
      },
    ] satisfies DeviceTelemetry[]

    const markup = renderCommandCenter(profile, 'SB-001', telemetry)

    expect(markup).toContain('固定云端 RTK 链路')
    expect(markup).not.toContain('<span>经度</span>')
    expect(markup).not.toContain('<span>纬度</span>')
    expect(markup).toContain('thing/product/SB-001/services')
    expect(markup).toContain('<span>机场推杆</span><strong>状态值 0</strong>')
    expect(markup).toContain('>展开推杆</button>')
    expect(markup).toContain('>闭合推杆</button>')
    expect(markup).toContain('通信与 LTE')
    expect(markup).toContain('4G 在线认证')
    expect(markup).toContain('未认证 · 4G 增强已开启 · 剩余时长 120s')
    expect(markup).toContain('value="13300000000"')
    expect(markup).toContain('>发送验证码</button>')
    expect(markup).toContain('>提交认证</button>')
    expect(markup).toContain('增强图传')
    expect(markup).toContain('重启机场')
    expect(markup).not.toContain('机场补光灯')
    expect(markup).not.toContain('环境与电池')
    expect(markup).not.toContain('通信与 eSIM')
    expect(markup).not.toContain('强制关闭舱盖')
    expect(markup).not.toContain('数据格式化')
  })

  it('rejects masked or clearly invalid SuperDock LTE credentials', () => {
    expect(isValidSuperDockLtePhone('86', '13300000000')).toBe(true)
    expect(isValidSuperDockLtePhone('1', '2025550123')).toBe(true)
    expect(isValidSuperDockLtePhone('086', '13300000000')).toBe(false)
    expect(isValidSuperDockLtePhone('86', '132*******1')).toBe(false)
    expect(isValidSuperDockLtePhone('86', '123')).toBe(false)
    expect(isValidSuperDockLteVerificationCode('123456')).toBe(true)
    expect(isValidSuperDockLteVerificationCode('123')).toBe(false)
    expect(isValidSuperDockLteVerificationCode('12*456')).toBe(false)
  })

  it('prefers the device LTE authentication result over a pending verification code', () => {
    expect(superDockLteAuthenticationStatus(true, true)).toBe('校验成功')
    expect(superDockLteAuthenticationStatus(false, false)).toBe('未认证')
    expect(superDockLteAuthenticationStatus(false, true)).toBe('验证码已发送')
    expect(superDockLteAuthenticationStatus(undefined, false)).toBe('等待认证状态')
  })

  it('lists remote debugging separately from the other control categories', () => {
    const profile = {
      id: 'profile',
      devices: [
        { id: 'dock', name: '二代机场', sn: 'DOCK-1', type: 'dock' },
        { id: 'aircraft', name: '库内飞机', sn: 'AIR-1', type: 'aircraft', parentSn: 'DOCK-1' },
      ],
    } as ConnectionProfile
    const telemetry = [
      {
        profileId: 'profile', sn: 'DOCK-1', type: 'dock', name: '二代机场', online: true,
        lastSeenAt: Date.now(), lastTopic: 'thing/product/DOCK-1/osd', status: {}, state: {},
        osd: {
          mode_code: 2,
          cover_state: 1,
          supplement_light_state: 0,
          alarm_state: 1,
          battery_store_mode: 1,
          wireless_link: { link_workmode: 0 },
          air_conditioner: { air_conditioner_state: 2, switch_time: 0 },
          drone_battery_maintenance_info: { maintenance_state: 2 },
          dongle_infos: [
            { imei: 'DOCK-IMEI-1', esim_activate_state: 1, sim_slot: 1, esim_infos: [] },
            { imei: 'DOCK-IMEI-2', esim_activate_state: 2, sim_slot: 2, esim_infos: [{ telecom_operator: 1, enabled: true }] },
          ],
          longitude: 113.9,
          latitude: 22.5,
          height: 18.2,
        },
      },
      {
        profileId: 'profile', sn: 'AIR-1', gatewaySn: 'DOCK-1', type: 'aircraft', name: '库内飞机', online: true,
        lastSeenAt: Date.now(), lastTopic: 'thing/product/DOCK-1/osd', status: {}, state: {},
        osd: { device_online_status: 1, drone_charge_state: { state: 1 } },
      },
    ] satisfies DeviceTelemetry[]

    const markup = renderCommandCenter(profile, 'DOCK-1', telemetry)

    expect(markup).toContain('远程调试')
    expect(markup).toContain('相机与云台')
    expect(markup).not.toContain('视频直播')
    expect(markup).toContain('远程调试中')
    expect(markup).toContain('退出远程调试')
    expect(markup).toContain('<span>机场舱盖</span><strong>已打开</strong>')
    expect(markup).toContain('>关闭舱盖</button>')
    expect(markup).not.toContain('>打开舱盖</button>')
    expect(markup).toContain('<span>飞机电源</span><strong>已开机</strong>')
    expect(markup).toContain('>飞机关机</button>')
    expect(markup).not.toContain('>飞机开机</button>')
    expect(markup).toContain('<span>飞机充电</span><strong>充电中</strong>')
    expect(markup).toContain('>停止充电</button>')
    expect(markup).not.toContain('>开启充电</button>')
    expect(markup).not.toContain('全部调试指令')
    expect(markup).not.toContain('请求 Payload')
    expect(markup).toContain('基础设备')
    expect(markup).toContain('环境与电池')
    expect(markup).toContain('通信与 eSIM')
    expect(markup).toContain('维护与标定')
    expect(markup).toContain('>打开补光灯</button>')
    expect(markup).toContain('>关闭声光报警</button>')
    expect(markup).toContain('>切换至待命模式</button>')
    expect(markup).toContain('>停止电池保养</button>')
    expect(markup).toContain('>开启 4G 增强</button>')
    expect(markup).toContain('2 个 Dongle')
    expect(markup).toContain('DOCK-IMEI-1')
    expect(markup).toContain('>激活 eSIM</button>')
    expect(markup).toContain('>切换至 eSIM</button>')
    expect(markup).toContain('>切换运营商</button>')
    expect(markup).toContain('RTK 一键标定')
    expect(markup.match(/class="debug-select-control"/g)).toHaveLength(4)
    expect(markup).toContain('aria-label="机场空调目标模式"')
    expect(markup).toContain('>格式化机场</button>')
    expect(markup).toContain('>格式化飞行器</button>')
    expect(markup).not.toContain('机场控制')
    expect(markup).not.toContain('debug-operation-result')
  })

  it('locks debug operations until the dock reports remote debugging mode', () => {
    const profile = {
      id: 'profile',
      devices: [{ id: 'dock', name: '二代机场', sn: 'DOCK-1', type: 'dock' }],
    } as ConnectionProfile
    const telemetry = [{
      profileId: 'profile', sn: 'DOCK-1', type: 'dock', name: '二代机场', online: true,
      lastSeenAt: Date.now(), lastTopic: 'thing/product/DOCK-1/osd', status: {}, state: {},
      osd: { mode_code: 0, cover_state: 0 },
    }] satisfies DeviceTelemetry[]

    const markup = renderCommandCenter(profile, 'DOCK-1', telemetry)

    expect(markup).toContain('未进入远程调试')
    expect(markup).toContain('进入远程调试')
    expect(markup).toContain('请先进入远程调试模式')
    expect(markup).toMatch(/debug-operation-card locked[\s\S]*?>打开舱盖<\/button>/)
    expect(markup).toMatch(/<button class="button secondary" disabled="">打开舱盖<\/button>/)
  })

  it('groups every command that requires debug mode with the mode switches', () => {
    const debugCommands = DJI_COMMANDS.filter((command) => command.category === 'debug')
    const requiredDebugCommands = DJI_COMMANDS.filter((command) => command.requiresDebug)

    expect(debugCommands.map((command) => command.id)).toEqual(expect.arrayContaining(['debug-open', 'debug-close']))
    expect(requiredDebugCommands.every((command) => command.category === 'debug')).toBe(true)
  })

  it('covers every Dock 3 remote debugging service method', () => {
    const methods = DJI_COMMANDS
      .filter((command) => command.category === 'debug')
      .map((command) => command.method)

    expect(methods).toEqual([
      'debug_mode_open',
      'debug_mode_close',
      'cover_open',
      'cover_close',
      'cover_force_close',
      'drone_open',
      'drone_close',
      'charge_open',
      'charge_close',
      'device_reboot',
      'esim_operator_switch',
      'sim_slot_switch',
      'esim_activate',
      'sdr_workmode_switch',
      'drone_format',
      'device_format',
      'battery_store_mode_switch',
      'alarm_state_switch',
      'air_conditioner_mode_switch',
      'battery_maintenance_switch',
      'supplement_light_close',
      'supplement_light_open',
      'rtk_calibration',
    ])
  })
})

describe('CommandCenter camera category', () => {
  it('only lists cameras from the selected airport and its aircraft', () => {
    const profile = {
      id: 'profile',
      devices: [
        { id: 'dock-a', name: '一号机场', sn: 'DOCK-A', type: 'dock' },
        { id: 'air-a', name: '巡检飞机', sn: 'AIR-A', type: 'aircraft', parentSn: 'DOCK-A' },
        { id: 'dock-b', name: '二号机场', sn: 'DOCK-B', type: 'dock' },
      ],
    } as ConnectionProfile
    const telemetry = [
      {
        profileId: 'profile', sn: 'DOCK-A', type: 'dock', name: '一号机场', online: true,
        lastSeenAt: Date.now(), lastTopic: 'thing/product/DOCK-A/osd', status: {}, state: {},
        osd: {
          live_capacity: { available_video_number: 3, coexist_video_number_max: 2, device_list: [
            { sn: 'DOCK-A', camera_list: [{ camera_index: '165-0-0', video_list: [{ video_index: 'normal-0', video_type: 'normal' }] }] },
            { sn: 'AIR-A', camera_list: [{ camera_index: '81-0-0', video_list: [{ video_index: 'normal-0', video_type: 'wide', switchable_video_types: ['wide', 'normal', 'zoom', 'ir'] }] }] },
          ] },
          live_status: [
            { video_id: 'AIR-A/81-0-0/normal-0', status: 1 },
          ],
        },
      },
      {
        profileId: 'profile', sn: 'DOCK-B', type: 'dock', name: '二号机场', online: true,
        lastSeenAt: Date.now(), lastTopic: 'thing/product/DOCK-B/osd', status: {}, state: {},
        osd: { live_capacity: { device_list: [{ sn: 'DOCK-B', camera_list: [{ camera_index: '165-0-0', video_list: [{ video_index: 'normal-0', video_type: 'normal' }] }] }] } },
      },
    ] satisfies DeviceTelemetry[]
    const mediaServers = [{
      id: 'new-cloud-media',
      name: '华为云服务器测试',
      kind: 'remote-easymedia',
      host: 'webrtc.junpzx.cn',
      apiProtocol: 'https',
      apiPort: 443,
      httpProtocol: 'https',
      httpPort: 443,
      rtmpPort: 1935,
      rtspPort: 0,
      webrtcPort: 8000,
      secret: '',
      isDefault: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }] satisfies MediaServerProfile[]

    const markup = renderToStaticMarkup(
      <CommandCenter
        profile={profile}
        status="connected"
        busy={false}
        selectedDeviceSn="DOCK-A"
        telemetry={telemetry}
        onPublish={async () => ({ ok: true })}
        allowedCategories={['payload']}
        mediaServers={mediaServers}
      />,
    )

    expect(markup).not.toContain('camera-console-header')
    expect(markup).not.toContain('camera-device-status')
    expect(markup.match(/camera-source-row/g)).toHaveLength(2)
    expect(markup.match(/camera-monitor-tile/g)).toHaveLength(2)
    expect(markup.match(/class="camera-player"/g)).toHaveLength(2)
    expect(markup).toContain('机场 · 一号机场')
    expect(markup).toContain('飞机 · 巡检飞机')
    expect(markup).toContain('设备 SN：AIR-A')
    expect(markup).toContain('相机下标：81-0-0')
    expect(markup).toContain('广角 / 普通 / 变焦 / 红外')
    expect(markup).not.toContain('种镜头 ·')
    expect(markup).toContain('aria-label="多路相机监看"')
    expect(markup).not.toContain('全部视频镜头')
    expect(markup).not.toContain('路视频源 ·')
    expect(markup).not.toContain('camera-detail-header')
    expect(markup).toContain('aria-label="直播设置"')
    expect(markup).toContain('华为云服务器测试 · webrtc.junpzx.cn')
    expect(markup).not.toContain('OSD 当前推流')
    expect(markup).not.toContain('OSD 上报最大')
    expect(markup).not.toContain('最大并发推流')
    expect(markup.indexOf('aria-label="直播设置"')).toBeLessThan(markup.indexOf('class="camera-detail"'))
    expect(markup).toContain('role="separator"')
    expect(markup.indexOf('全部播放')).toBeLessThan(markup.indexOf('class="camera-detail"'))
    expect(markup).not.toContain('camera-monitor-bulk-actions')
    expect(markup).toContain('normal-0')
    expect(markup).toContain('class="camera-monitor-select camera-lens-select"')
    expect(markup).toContain('aria-label="normal-0 切换镜头"')
    expect(markup.match(/camera-position-select/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="normal-0 切换机场相机"')
    expect(markup).toContain('>舱内</option>')
    expect(markup).toContain('>舱外</option>')
    expect(markup.match(/camera-quality-select/g)).toHaveLength(2)
    expect(markup).toContain('aria-label="normal-0 切换清晰度"')
    expect(markup).not.toContain('独立视频源')
    expect(markup).not.toContain('camera-lens-mode-list')
    expect(markup).not.toContain('aria-pressed=')
    expect(markup.indexOf('>广角</option>')).toBeLessThan(markup.indexOf('>普通</option>'))
    expect(markup.indexOf('>普通</option>')).toBeLessThan(markup.indexOf('>变焦</option>'))
    expect(markup.indexOf('>变焦</option>')).toBeLessThan(markup.indexOf('>红外</option>'))
    expect(markup).toContain('未直播')
    expect(markup).not.toContain('二号机场')
    expect(markup).not.toContain('DOCK-B')
    expect(markup).toContain('全部播放')
    expect(markup).toContain('>播放</button>')
    expect(markup).toContain('获取负载控制权')
    expect(markup).toContain('云台回中')
  })

  it('defines the Dock 3 live camera change service payload', () => {
    expect(DJI_COMMANDS.find((command) => command.id === 'live-camera-change')).toMatchObject({
      category: 'live',
      method: 'live_camera_change',
      data: { video_id: '', camera_position: 0 },
    })
  })
})

describe('CommandCenter flight authority gate', () => {
  const profile = {
    id: 'profile',
    devices: [
      { id: 'dock', name: '二代机场', sn: 'DOCK-1', type: 'dock' },
      { id: 'aircraft', name: '库内飞机', sn: 'AIR-1', type: 'aircraft', parentSn: 'DOCK-1' },
    ],
  } as ConnectionProfile

  it('locks all flight operations until DRC reports that control authority is connected', () => {
    const telemetry = [{
      profileId: 'profile', sn: 'DOCK-1', type: 'dock', name: '二代机场', online: true,
      lastSeenAt: Date.now(), lastTopic: 'thing/product/DOCK-1/state', status: {}, osd: {},
      state: { drc_state: 0 },
    }] satisfies DeviceTelemetry[]

    const markup = renderFlightCenter(profile, telemetry)

    expect(markup).toContain('未获取控制权')
    expect(markup).toContain('获取飞行控制权')
    expect(markup).not.toContain('释放飞行控制权')
    expect(markup.match(/class="command-tile[^\"]*locked[^\"]*" disabled=""/g)).toHaveLength(4)
    expect(markup).toContain('需先获取飞行控制权')
    expect(markup).toContain('>等待控制权</button>')
  })

  it('unlocks flight operations and offers release after control authority is connected', () => {
    const telemetry = [
      {
        profileId: 'profile', sn: 'DOCK-1', type: 'dock', name: '二代机场', online: true,
        lastSeenAt: Date.now(), lastTopic: 'thing/product/DOCK-1/state', status: {}, osd: {},
        state: { drc_state: 2 },
      },
      {
        profileId: 'profile', sn: 'AIR-1', gatewaySn: 'DOCK-1', type: 'aircraft', name: '库内飞机', online: true,
        lastSeenAt: Date.now(), lastTopic: 'thing/product/AIR-1/state', status: {}, osd: {},
        state: { control_source: 'cloud-console' },
      },
    ] satisfies DeviceTelemetry[]

    const markup = renderFlightCenter(profile, telemetry)

    expect(markup).toContain('已获取控制权')
    expect(markup).toContain('控制源 cloud-console')
    expect(markup).toContain('释放飞行控制权')
    expect(markup).not.toContain('>获取飞行控制权</button>')
    expect(markup).not.toMatch(/class="command-tile[^\"]*locked/)
    expect(markup).toContain('>发送指令</button>')
  })

  it('marks every post-authority flight command as requiring control authority', () => {
    const postAuthorityCommands = DJI_COMMANDS.filter((command) =>
      command.category === 'flight'
      && command.id !== 'flight-authority-grab'
      && command.id !== 'flight-authority-release',
    )

    expect(postAuthorityCommands).toHaveLength(4)
    expect(postAuthorityCommands.every((command) => command.requiresFlightAuthority)).toBe(true)
  })
})
