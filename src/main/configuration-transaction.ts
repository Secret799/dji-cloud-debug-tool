import { AsyncLocalStorage } from 'node:async_hooks'

const context = new AsyncLocalStorage<{ active: boolean }>()
let queue: Promise<void> = Promise.resolve()

// Store operations join an enclosing backup transaction; unrelated IPC work waits.
export const runConfigurationTransaction = <T>(operation: () => Promise<T>): Promise<T> => {
  if (context.getStore()?.active) return operation()
  const result = queue.then(() => {
    const transaction = { active: true }
    return context.run(transaction, async () => {
      try {
        return await operation()
      } finally {
        transaction.active = false
      }
    })
  })
  queue = result.then(() => undefined, () => undefined)
  return result
}
