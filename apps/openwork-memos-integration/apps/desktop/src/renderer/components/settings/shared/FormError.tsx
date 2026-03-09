// apps/desktop/src/renderer/components/settings/shared/FormError.tsx

interface FormErrorProps {
  error: string | null;
}

export function FormError({ error }: FormErrorProps) {
  if (!error) return null;

  return (
    <p className="text-sm text-destructive">{error}</p>
  );
}
