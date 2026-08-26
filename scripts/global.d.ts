import type { MqttRuntimeEvent } from '../src/shared/contracts'

declare global {
  interface Window {
    __mqttSmokeEvents: MqttRuntimeEvent[]
  }
}

export {}
