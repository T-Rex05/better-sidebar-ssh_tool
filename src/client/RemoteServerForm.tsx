/**
 * The add/edit server modal: name / host / port / username / auth type /
 * password (empty on edit = keep the stored one) / private key path /
 * passphrase / root path, with a test-connection button and save.
 */
import { useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type RemoteAuthType, type RemoteServerInput, type RemoteServerSafe } from './api.ts'
import { t, type CopyKey } from './locales.ts'
import css from './sidebar.module.css'

/** One text field's definition (labels come from the i18n keys). */
interface FieldSpec {
  key: keyof RemoteServerInput
  type?: string
}

const FIELDS: readonly FieldSpec[] = [
  { key: 'name' },
  { key: 'host' },
  { key: 'port', type: 'number' },
  { key: 'username' },
  { key: 'rootPath' },
]

export function RemoteServerForm(props: {
  server?: RemoteServerSafe
  onClose: () => void
  onSaved: () => void
}) {
  const { server, onClose, onSaved } = props
  const [form, setForm] = useState<RemoteServerInput>(() => ({
    id: server?.id,
    name: server?.name ?? '',
    host: server?.host ?? '',
    port: server?.port ?? 22,
    username: server?.username ?? '',
    authType: server?.authType ?? 'password',
    password: '',
    privateKeyPath: server?.privateKeyPath ?? '',
    passphrase: '',
    rootPath: server?.rootPath ?? '',
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  const set = (patch: Partial<RemoteServerInput>): void => { setForm(prev => ({ ...prev, ...patch })) }

  const portNumber = (): number => {
    const value = typeof form.port === 'number' ? form.port : Number(form.port)
    return Number.isInteger(value) ? value : NaN
  }

  const payload = (): RemoteServerInput => ({ ...form, port: portNumber() })

  const runTest = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      const result = await api.remoteTest(payload())
      setTestResult(t('remoteTestOk', { home: result.home }))
    } catch (reason) {
      setTestResult(t('remoteTestFailed') + ': ' + (reason instanceof Error ? reason.message : String(reason)))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!Number.isInteger(payload().port) || payload().port < 1 || payload().port > 65535) {
      setError(t('remoteInvalidPort'))
      return
    }
    if (form.name.trim() === '' || form.host.trim() === '' || form.username.trim() === '') {
      setError(t('remoteRequiredFields'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.remoteSaveServer(payload())
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const renderField = (field: FieldSpec) => (
    <div key={field.key} className={css.remoteFormRow}>
      <label className={css.remoteFormLabel}>{t(('remoteField' + field.key.charAt(0).toUpperCase() + field.key.slice(1)) as CopyKey)}</label>
      <Input
        type={field.type ?? 'text'}
        value={String(form[field.key] ?? '')}
        disabled={busy}
        onChange={(event) => {
          const value = event.target.value
          if (field.key === 'port') set({ port: value === '' ? NaN : Number(value) })
          else set({ [field.key]: value } as Partial<RemoteServerInput>)
        }}
      />
    </div>
  )

  return (
    <Modal
      open
      onClose={onClose}
      title={server === undefined ? t('remoteAddServer') : t('remoteEditServer')}
      closeLabel={t('cancel')}
      className={css.remoteFormModal}
      footer={(<Button variant='primary' disabled={busy} onClick={() => { void save() }}>{t('save')}</Button>)}
    >
      <div className={css.remoteForm}>
        {FIELDS.map(renderField)}
        <div className={css.remoteFormRow}>
          <label className={css.remoteFormLabel}>{t('remoteAuthType')}</label>
          <select
            className={css.remoteAuthSelect}
            value={form.authType}
            disabled={busy}
            onChange={(event) => { set({ authType: event.target.value as RemoteAuthType }) }}
          >
            <option value='password'>{t('remoteAuthPassword')}</option>
            <option value='privateKey'>{t('remoteAuthKey')}</option>
            <option value='agent'>{t('remoteAuthAgent')}</option>
          </select>
        </div>
        {form.authType === 'agent' && (
          <div className={css.remoteFormNote}>{t('remoteAgentHint')}</div>
        )}
        {form.authType === 'password' && (
          <div className={css.remoteFormRow}>
            <label className={css.remoteFormLabel}>{t('remotePassword')}</label>
            <Input
              type='password'
              value={form.password ?? ''}
              disabled={busy}
              placeholder={server?.hasPassword === true ? t('remotePasswordKeep') : ''}
              onChange={(event) => { set({ password: event.target.value }) }}
            />
          </div>
        )}
        {form.authType === 'privateKey' && (
          <>
            <div className={css.remoteFormRow}>
              <label className={css.remoteFormLabel}>{t('remoteKeyPath')}</label>
              <Input
                value={form.privateKeyPath ?? ''}
                disabled={busy}
                placeholder={t('remoteKeyPathPlaceholder')}
                onChange={(event) => { set({ privateKeyPath: event.target.value }) }}
              />
            </div>
            <div className={css.remoteFormRow}>
              <label className={css.remoteFormLabel}>{t('remotePassphrase')}</label>
              <Input
                type='password'
                value={form.passphrase ?? ''}
                disabled={busy}
                placeholder={server?.hasPassphrase === true ? t('remotePasswordKeep') : ''}
                onChange={(event) => { set({ passphrase: event.target.value }) }}
              />
            </div>
          </>
        )}
        <div className={css.remoteFormActions}>
          <Button variant='outline' disabled={busy} onClick={() => { void runTest() }}>{t('remoteTest')}</Button>
        </div>
        {testResult !== null && <div className={css.remoteFormNote}>{testResult}</div>}
        {error !== null && <div className={css.explorerError}>{error}</div>}
      </div>
    </Modal>
  )
}
