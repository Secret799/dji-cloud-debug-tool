import electronPath from 'electron'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(import.meta.dirname, '..')
const userData = await mkdtemp(join(tmpdir(), 'dji-cloud-studio-mqtt-'))
const electronApp = await electron.launch({
  executablePath: electronPath,
  args: [projectRoot, `--user-data-dir=${userData}`],
  cwd: projectRoot,
})

try {
  const window = await electronApp.firstWindow()
  await window.locator('.app-shell').waitFor({ state: 'visible', timeout: 15_000 })

  const connection = await window.evaluate(async () => {
    window.__mqttSmokeEvents = []
    window.djiApi.events.onRuntimeEvent((event) => window.__mqttSmokeEvents.push(event))
    const [profile] = await window.djiApi.profiles.list()
    const result = await window.djiApi.mqtt.connect(profile.id)
    return { profileId: profile.id, result }
  })

  if (!connection.result.ok) throw new Error(connection.result.error || 'MQTT connect invocation failed')
  await window.waitForFunction(
    (profileId) => window.__mqttSmokeEvents.some((event) => event.type === 'status' && event.profileId === profileId && event.status === 'connected'),
    connection.profileId,
    { timeout: 20_000 },
  )

  const testTopic = `dji-cloud-studio/smoke/${Date.now()}-${Math.random().toString(16).slice(2)}`
  const testPayload = JSON.stringify({ source: 'DJI Cloud Studio', timestamp: Date.now() })
  const operations = await window.evaluate(
    async ({ profileId, topic, payload }) => {
      const subscribed = await window.djiApi.mqtt.subscribe(profileId, topic, 1)
      const published = await window.djiApi.mqtt.publish({ profileId, topic, payload, qos: 1, retain: false })
      return { subscribed, published }
    },
    { profileId: connection.profileId, topic: testTopic, payload: testPayload },
  )

  if (!operations.subscribed.ok) throw new Error(operations.subscribed.error || 'MQTT subscribe failed')
  if (!operations.published.ok) throw new Error(operations.published.error || 'MQTT publish failed')

  await window.waitForFunction(
    ({ profileId, topic, payload }) =>
      window.__mqttSmokeEvents.some(
        (event) =>
          event.type === 'message'
          && event.profileId === profileId
          && event.message.direction === 'in'
          && event.message.topic === topic
          && event.message.payload === payload,
      ),
    { profileId: connection.profileId, topic: testTopic, payload: testPayload },
    { timeout: 20_000 },
  )

  await window.evaluate((profileId) => window.djiApi.mqtt.disconnect(profileId), connection.profileId)
  process.stdout.write(`${JSON.stringify({ broker: 'broker.emqx.io:1883', testTopic, connected: true, roundTrip: true }, null, 2)}\n`)
} finally {
  await electronApp.close()
}
