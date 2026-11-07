import { useEffect, useRef, useState } from 'react'
import { PROVIDERS, type Provider, type ProviderSettings } from '../shared/providers'

type Requests = {
  get: () => Promise<ProviderSettings>
  setProvider: (provider: Provider) => Promise<ProviderSettings>
  saveKey: (provider: Provider, key: string) => Promise<ProviderSettings>
  deleteKey: (provider: Provider) => Promise<ProviderSettings>
}

const SOURCE = {
  environment: 'From the launching environment',
  keychain: 'Saved in macOS Keychain',
  none: 'Not configured',
} as const

/** Provider choice and API keys. Keys go to the keychain; they are never sent back here. */
export function SettingsDialog({
  open,
  onClose,
  requests,
  hostRunning,
}: {
  open: boolean
  onClose: () => void
  requests: Requests
  hostRunning: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [settings, setSettings] = useState<ProviderSettings>()
  const [selected, setSelected] = useState<Provider>('spark')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const apply = (next: ProviderSettings) => {
    setSettings(next)
    setError(next.error)
  }
  const run = async (action: () => Promise<ProviderSettings>) => {
    setBusy(true)
    try {
      apply(await action())
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the dialog opens.
  useEffect(() => {
    if (!open) return dialog.current?.close()
    dialog.current?.showModal()
    setKey('')
    void run(async () => {
      const next = await requests.get()
      setSelected(next.provider)
      return next
    })
  }, [open])
  const source = settings?.keys[selected] ?? 'none'
  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <h2 id="settings-title">Provider settings</h2>
      <fieldset className="providers" disabled={busy || settings?.providerFromEnvironment}>
        <legend>Provider</legend>
        {(Object.keys(PROVIDERS) as Provider[]).map((provider) => (
          <label key={provider} className={settings?.provider === provider ? 'active' : ''}>
            <input
              type="radio"
              name="provider"
              checked={selected === provider}
              onChange={() => {
                setSelected(provider)
                setKey('')
                void run(() => requests.setProvider(provider))
              }}
            />
            <span>{PROVIDERS[provider].label}</span>
            <span className={`key-source ${settings?.keys[provider] ?? 'none'}`}>
              {SOURCE[settings?.keys[provider] ?? 'none']}
            </span>
          </label>
        ))}
      </fieldset>
      {settings?.providerFromEnvironment && (
        <p className="note">
          LLM_PROVIDER is set in the launching environment and takes precedence.
        </p>
      )}
      <form
        className="key-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!key.trim()) return
          void run(() => requests.saveKey(selected, key)).then(() => setKey(''))
        }}
      >
        <label htmlFor="api-key">{PROVIDERS[selected].variable}</label>
        <div className="key-row">
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={source === 'keychain' ? 'Enter a new key to replace it' : 'Paste API key'}
            value={key}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" className="primary" disabled={busy || !key.trim()}>
            {source === 'keychain' ? 'Replace' : 'Save'}
          </button>
          {source === 'keychain' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => requests.deleteKey(selected))}
            >
              Delete
            </button>
          )}
        </div>
        {source === 'environment' && (
          <p className="note">
            {PROVIDERS[selected].variable} from the launching environment is used before the
            keychain.
          </p>
        )}
      </form>
      {error && <p className="failure">{error}</p>}
      <div className="settings-footer">
        <p className="note">
          {hostRunning
            ? 'Changes apply to the next session you open.'
            : 'Keys are stored in your login keychain and passed only to the engine process.'}
        </p>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </dialog>
  )
}
