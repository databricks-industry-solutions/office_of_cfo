import { FormEvent, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Eye, EyeOff, RefreshCw } from "lucide-react";
import type { Persona } from "../api";
import SignalNetworkBackdrop from "./SignalNetworkBackdrop";
import { Skeleton, SkeletonRegion } from "./ui";

interface EntranceProps {
  personas: Persona[];
  savedId: string | null;
  loadError?: string | null;
  onEnter: (id: string) => void;
  onRetry?: () => void;
}

function defaultPersonaId(personas: Persona[], savedId: string | null) {
  return personas.find((persona) => persona.id === savedId)?.id ?? personas[0]?.id ?? null;
}

export default function Entrance({
  personas,
  savedId,
  loadError,
  onEnter,
  onRetry,
}: EntranceProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [resetHint, setResetHint] = useState(false);
  const fallbackId = defaultPersonaId(personas, savedId);

  const enterDemo = () => {
    if (fallbackId) onEnter(fallbackId);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    enterDemo();
  };

  return (
    <main className="entrance relative min-h-[100dvh] overflow-x-hidden overflow-y-auto text-fg">
      <SignalNetworkBackdrop />

      <p
        className="entrance-wordmark pointer-events-none absolute z-20 font-display text-[#1E232B]"
        data-testid="entrance-wordmark"
      >
        <span className="entrance-wordmark-office">Office</span>
        <span className="entrance-wordmark-of">of the</span>
        <span className="entrance-wordmark-cfo">CFO</span>
      </p>

      <div className="relative z-10 flex min-h-[100dvh] w-full items-center px-5 pb-10 pt-[42vh] sm:px-8 sm:py-10 lg:pl-10 lg:pr-14">
        <motion.section
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: "easeOut" }}
          className="entrance-card w-full max-w-[26.5rem] rounded-2xl border border-line p-7 sm:p-8"
        >
          <h1 className="font-display text-[1.85rem] font-medium tracking-[-0.035em] text-fg">
            Welcome back
          </h1>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            Sign in to access your financial operating system.
          </p>

          <form className="mt-7" onSubmit={onSubmit}>
            <label htmlFor="entrance-email" className="block text-xs font-medium text-fg-muted">
              Work email
            </label>
            <input
              id="entrance-email"
              name="email"
              type="email"
              autoComplete="username"
              className="mt-2 h-10 w-full rounded-lg border border-line-strong bg-white px-3 text-sm text-fg outline-none transition focus-visible:ring-2 focus-visible:ring-[#2B4C7E]/50"
            />

            <label htmlFor="entrance-password" className="mt-4 block text-xs font-medium text-fg-muted">
              Password
            </label>
            <div className="relative mt-2">
              <input
                id="entrance-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                className="h-10 w-full rounded-lg border border-line-strong bg-white px-3 pr-11 text-sm text-fg outline-none transition focus-visible:ring-2 focus-visible:ring-[#2B4C7E]/50"
              />
              <button
                type="button"
                className="absolute inset-y-0 right-0 grid w-11 place-items-center text-fg-subtle hover:text-fg"
                onClick={() => setShowPassword((open) => !open)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            <div className="mt-2 mb-4 flex justify-end">
              <button
                type="button"
                className="text-xs text-[#2B4C7E] hover:underline"
                onClick={() => setResetHint(true)}
              >
                Forgot password?
              </button>
            </div>
            {resetHint && (
              <p className="mb-4 text-xs leading-5 text-fg-muted">
                Password resets are managed by your finance admin.
              </p>
            )}

            <button
              type="submit"
              disabled={!fallbackId}
              className="h-11 w-full rounded-lg bg-[#2B4C7E] text-sm font-semibold text-white transition hover:bg-[#243f68] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B4C7E]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#f6f5f2]"
            >
              Sign in
            </button>
          </form>

          <div className="my-5 flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>

          <button
            type="button"
            disabled={!fallbackId}
            onClick={enterDemo}
            className="h-10 w-full rounded-lg border border-line-strong bg-white text-sm text-fg transition hover:border-[#2B4C7E]/35 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B4C7E]/50"
          >
            Continue with Microsoft
          </button>

          <div className="my-5 flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            <span className="h-px flex-1 bg-line" />
            Enter as a role
            <span className="h-px flex-1 bg-line" />
          </div>

          {loadError ? (
            <div className="rounded-xl border border-line px-4 py-5 text-center" role="alert">
              <AlertTriangle className="mx-auto mb-3 text-amber-600" size={20} aria-hidden="true" />
              <p className="text-sm font-medium text-fg">Unable to load roles</p>
              <p className="mt-1 text-xs text-fg-muted">{loadError}</p>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mt-3 inline-flex items-center gap-2 text-sm text-[#2B4C7E]"
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Try again
                </button>
              )}
            </div>
          ) : personas.length === 0 ? (
            <SkeletonRegion label="Loading roles" className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </SkeletonRegion>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {personas.map((persona) => (
                <button
                  key={persona.id}
                  type="button"
                  onClick={() => onEnter(persona.id)}
                  className="h-10 rounded-lg border border-line bg-[#f6f5f2] text-xs font-medium text-fg transition hover:border-[#2B4C7E]/40 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2B4C7E]/50"
                >
                  {persona.label}
                </button>
              ))}
            </div>
          )}
        </motion.section>
      </div>
    </main>
  );
}
