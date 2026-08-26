import { describe, expect, it } from 'vitest'
import {
  DJI_DOCK3_WRITABLE_FIELDS,
  getDjiDock3FieldMetadata,
} from './dji-dock3-field-metadata'

describe('DJI Dock 3 writable field metadata', () => {
  it('tracks every field marked read/write in the official Dock 3 table', () => {
    expect(DJI_DOCK3_WRITABLE_FIELDS.map((field) => field.path)).toEqual([
      'air_transfer_enable',
      'silent_mode',
      'user_experience_improvement',
    ])
    expect(DJI_DOCK3_WRITABLE_FIELDS.every((field) => field.accessMode === 'rw')).toBe(true)
  })

  it('does not apply partial Dock 3 metadata to read-only fields', () => {
    expect(getDjiDock3FieldMetadata('silent_mode')?.enumValues?.['1']).toBe('静音模式')
    expect(getDjiDock3FieldMetadata('cover_state')).toBeUndefined()
  })
})
