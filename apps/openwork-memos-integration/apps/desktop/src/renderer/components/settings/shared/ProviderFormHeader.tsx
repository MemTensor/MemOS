// apps/desktop/src/renderer/components/settings/shared/ProviderFormHeader.tsx

interface ProviderFormHeaderProps {
  logoSrc: string;
  providerName: string;
}

export function ProviderFormHeader({ logoSrc, providerName }: ProviderFormHeaderProps) {
  return (
    <div className="flex items-center gap-3 mb-5">
      {/* Fixed-size container to prevent layout shift when switching providers */}
      <div className="h-8 w-8 flex items-center justify-center flex-shrink-0">
        <img
          src={logoSrc}
          alt={`${providerName} logo`}
          className="h-6 w-6 object-contain"
        />
      </div>
      <span className="text-base font-medium text-foreground">{providerName} Settings</span>
    </div>
  );
}
