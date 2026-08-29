import { useEffect, useRef, useState } from 'react'
import { Cloud, Database, KeyRound, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react'
import type { ObjectStorageProfile, ObjectStorageProvider, OperationResult } from '../../../shared/contracts'
import { createObjectStorageProfile, objectStorageProfileIssues } from '../lib/object-storage'
import { SecretInput } from '../components/SecretInput'
import { Tooltip } from '../components/Tooltip'

interface OssManagerProps {
  profiles: ObjectStorageProfile[]
  selectedId: string
  onSelect: (profileId: string) => void
  onSave: (profile: ObjectStorageProfile) => Promise<ObjectStorageProfile>
  onRemove: (profileId: string) => Promise<OperationResult>
  onNotify: (text: string, tone?: 'info' | 'success' | 'error') => void
}

const providerLabels: Record<ObjectStorageProvider, string> = {
  ali: '阿里云 OSS',
  aws: 'Amazon S3',
  minio: 'MinIO',
}

const providerDefaults: Record<ObjectStorageProvider, { region: string; endpoint: string }> = {
  ali: { region: 'cn-hangzhou', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com' },
  aws: { region: 'us-east-1', endpoint: 'https://s3.amazonaws.com' },
  minio: { region: '', endpoint: 'http://127.0.0.1:9000' },
}

const cloneProfile = (profile: ObjectStorageProfile): ObjectStorageProfile => ({ ...profile })

export function OssManager({ profiles, selectedId, onSelect, onSave, onRemove, onNotify }: OssManagerProps) {
  const selected = profiles.find((profile) => profile.id === selectedId)
  const [draft, setDraft] = useState<ObjectStorageProfile>(() => selected ? cloneProfile(selected) : createObjectStorageProfile())
  const [expire, setExpire] = useState(selected?.expire ? String(selected.expire) : String(draft.expire))
  const [isNew, setIsNew] = useState(!selected)
  const [saving, setSaving] = useState(false)
  const resolveGeneration = useRef(0)

  const resolveProfile = async (profile: ObjectStorageProfile, generation: number): Promise<void> => {
    try {
      const resolved = await window.djiApi.objectStorage.resolve(profile.id)
      if (resolveGeneration.current !== generation || !resolved) return
      setDraft((current) => {
        if (current.id !== resolved.id) return current
        return {
          ...current,
          accessKeySecret: current.accessKeySecret || current.clearStoredAccessKeySecret
            ? current.accessKeySecret
            : resolved.accessKeySecret,
          securityToken: current.securityToken || current.clearStoredSecurityToken
            ? current.securityToken
            : resolved.securityToken,
          hasStoredAccessKeySecret: resolved.hasStoredAccessKeySecret,
          hasStoredSecurityToken: resolved.hasStoredSecurityToken,
        }
      })
    } catch (error) {
      if (resolveGeneration.current !== generation) return
      onNotify(`解密对象存储凭据失败：${error instanceof Error ? error.message : String(error)}，可重新输入后保存`, 'error')
    }
  }

  useEffect(() => {
    const current = profiles.find((profile) => profile.id === selectedId)
    if (!current) return
    const generation = resolveGeneration.current + 1
    resolveGeneration.current = generation
    setDraft(cloneProfile(current))
    setExpire(String(current.expire))
    setIsNew(false)
    void resolveProfile(current, generation)
  }, [profiles, selectedId])

  useEffect(() => () => { resolveGeneration.current += 1 }, [])

  const editProfile = (profile: ObjectStorageProfile): void => {
    const generation = resolveGeneration.current + 1
    resolveGeneration.current = generation
    onSelect(profile.id)
    setDraft(cloneProfile(profile))
    setExpire(String(profile.expire))
    setIsNew(false)
    if (profile.id === selectedId) void resolveProfile(profile, generation)
  }

  const createProfile = (): void => {
    resolveGeneration.current += 1
    const next = createObjectStorageProfile()
    setDraft(next)
    setExpire(String(next.expire))
    setIsNew(true)
  }

  const handleSave = async (): Promise<void> => {
    const next = { ...draft, expire: Number(expire) }
    const issues = objectStorageProfileIssues(next)
    if (issues.length) {
      onNotify(`请填写：${issues.join('、')}`, 'error')
      return
    }
    setSaving(true)
    try {
      const saved = await onSave(next)
      resolveGeneration.current += 1
      setDraft(cloneProfile(saved))
      setExpire(String(saved.expire))
      setIsNew(false)
      onNotify('对象存储配置已保存', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (isNew || !profiles.some((profile) => profile.id === draft.id)) return
    if (!window.confirm(`确认删除对象存储“${draft.name}”？`)) return
    setSaving(true)
    try {
      const result = await onRemove(draft.id)
      if (!result.ok) throw new Error(result.error ?? '删除失败')
      onNotify('对象存储配置已删除', 'success')
      const remaining = profiles.filter((profile) => profile.id !== draft.id)
      if (!remaining.length) createProfile()
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  const issues = objectStorageProfileIssues(draft)

  return (
    <div className="oss-manager">
      <aside className="oss-profile-panel">
        <header>
          <div><span>存储配置</span><strong>{profiles.length}</strong></div>
          <Tooltip label="新增对象存储"><button className="icon-button small" onClick={createProfile}><Plus size={15} /></button></Tooltip>
        </header>
        <div className="oss-profile-list">
          {profiles.map((profile) => (
            <button key={profile.id} className={`oss-profile-row ${!isNew && draft.id === profile.id ? 'selected' : ''}`} onClick={() => editProfile(profile)}>
              <span className={`oss-provider-icon ${profile.provider}`}><Database size={15} /></span>
              <span><strong>{profile.name}</strong><small>{providerLabels[profile.provider]} · {profile.bucket}</small></span>
              <i className={objectStorageProfileIssues(profile).length ? 'incomplete' : 'ready'} />
            </button>
          ))}
          {!profiles.length && <div className="oss-profile-empty"><Database size={20} /><span>暂无对象存储配置</span></div>}
        </div>
      </aside>

      <section className="oss-config-section">
        <header className="oss-section-header">
          <div className="oss-section-icon"><Database size={18} /></div>
          <div><h2>{isNew ? '新增对象存储' : draft.name}</h2><span>{providerLabels[draft.provider]} · {draft.bucket || '未设置 Bucket'}</span></div>
          <span className={`oss-config-status ${issues.length ? 'incomplete' : 'ready'}`}>{issues.length ? '配置未完成' : '可以使用'}</span>
        </header>

        <form className="oss-config-form" autoComplete="off" onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}>
          <div className="oss-form-group">
            <div className="oss-form-group-title"><Cloud size={15} /><span>存储服务</span></div>
            <div className="field-grid two-columns">
              <label className="field"><span>配置名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
              <label className="field"><span>云存储厂商</span><select value={draft.provider} onChange={(event) => {
                const provider = event.target.value as ObjectStorageProvider
                setDraft((current) => ({ ...current, provider, ...providerDefaults[provider] }))
              }}>{Object.entries(providerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field"><span>Bucket</span><input value={draft.bucket} onChange={(event) => setDraft((current) => ({ ...current, bucket: event.target.value }))} /></label>
              <label className="field"><span>Region</span><input value={draft.region} onChange={(event) => setDraft((current) => ({ ...current, region: event.target.value }))} placeholder={draft.provider === 'minio' ? '可留空' : 'cn-hangzhou'} /></label>
              <label className="field oss-endpoint-field"><span>Endpoint</span><input value={draft.endpoint} onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))} placeholder="https://..." /></label>
            </div>
          </div>

          <div className="oss-form-group">
            <div className="oss-form-group-title"><KeyRound size={15} /><span>访问凭证</span></div>
            <div className="field-grid two-columns">
              <label className="field"><span>Access Key ID</span><input value={draft.accessKeyId} onChange={(event) => setDraft((current) => ({ ...current, accessKeyId: event.target.value }))} /></label>
              <SecretInput
                key={`${draft.id}:access-key-secret`}
                label="Access Key Secret"
                value={draft.accessKeySecret}
                onChange={(accessKeySecret) => setDraft((current) => ({
                  ...current,
                  accessKeySecret,
                  clearStoredAccessKeySecret: accessKeySecret ? false : Boolean(current.hasStoredAccessKeySecret),
                }))}
                placeholder={draft.clearStoredAccessKeySecret ? '请输入新密钥' : draft.hasStoredAccessKeySecret ? '已加密保存' : '必填'}
              />
              <SecretInput
                key={`${draft.id}:security-token`}
                label="Security Token"
                value={draft.securityToken}
                onChange={(securityToken) => setDraft((current) => ({
                  ...current,
                  securityToken,
                  clearStoredSecurityToken: securityToken ? false : Boolean(current.hasStoredSecurityToken),
                }))}
                placeholder={draft.clearStoredSecurityToken ? '保存后清除' : draft.hasStoredSecurityToken ? '已加密保存' : '可选'}
              />
              <label className="field"><span>凭证过期时间戳</span><input inputMode="numeric" value={expire} onChange={(event) => setExpire(event.target.value)} placeholder="毫秒或秒时间戳" /></label>
            </div>
          </div>

          <footer className="oss-config-footer">
            <span><ShieldCheck size={14} />密钥由应用内 AES-256-GCM 加密保存</span>
            <div className="oss-config-actions">
              {!isNew && <button className="button danger-ghost" type="button" disabled={saving} onClick={() => void handleRemove()}><Trash2 size={14} />删除</button>}
              <button className="button primary" type="submit" disabled={saving}><Save size={14} />{saving ? '保存中' : '保存配置'}</button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  )
}
