import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DjiDevice } from '../../../shared/contracts'
import { DeviceModal } from './DeviceModal'

const renderDeviceModal = (device: DjiDevice): string => renderToStaticMarkup(
  <DeviceModal
    device={device}
    isNew={false}
    gatewayDevices={[]}
    onClose={vi.fn()}
    onSave={vi.fn()}
    onRemove={vi.fn()}
  />,
)

describe('DeviceModal provider models', () => {
  it('renders DJI airport models for a DJI dock', () => {
    const markup = renderDeviceModal({
      id: 'dock',
      name: 'DJI Dock 3',
      sn: 'DJI-DOCK-1',
      type: 'dock',
      provider: 'dji',
      dockModel: 'dock3',
    })

    expect(markup).toContain('<button type="button" class="active">DJI</button>')
    expect(markup).toContain('<option value="dock3" selected="">DJI Dock 3</option>')
    expect(markup).not.toContain('SuperDock S24M4')
  })

  it('renders SuperDock models for a Strawberry airport', () => {
    const markup = renderDeviceModal({
      id: 'superdock',
      name: 'SuperDock S24M4',
      sn: 'SB-DOCK-1',
      type: 'dock',
      provider: 'superdock',
      dockModel: 's24m4',
    })

    expect(markup).toContain('<button type="button" class="active">草莓机场</button>')
    expect(markup).toContain('<option value="s24m4" selected="">SuperDock S24M4</option>')
    expect(markup).not.toContain('DJI Dock 3</option>')
  })
})
