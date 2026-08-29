import type { DeviceProvider, DjiDevice, DockModel } from './contracts'

const SUPERDOCK_DOCK_MODELS: ReadonlySet<DockModel> = new Set([
  's22m300',
  's2201',
  's2301',
  's24m350',
  's24m350s',
  's24m3',
  's24m4',
  's25m4',
  's25m400',
  's25m400s',
])

export const isSuperDockModel = (model: DockModel | undefined): boolean =>
  Boolean(model && SUPERDOCK_DOCK_MODELS.has(model))

export const resolveDeviceProvider = (
  device: Pick<DjiDevice, 'type' | 'provider' | 'dockModel'> | undefined,
): DeviceProvider => {
  if (device?.type !== 'dock') return 'dji'
  if (device.provider) return device.provider
  return isSuperDockModel(device.dockModel) ? 'superdock' : 'dji'
}
