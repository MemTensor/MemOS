// apps/desktop/src/renderer/components/settings/shared/RegionSelector.tsx

const AWS_REGIONS = [
  { id: 'us-east-1', name: 'US East (N. Virginia)' },
  { id: 'us-east-2', name: 'US East (Ohio)' },
  { id: 'us-west-1', name: 'US West (N. California)' },
  { id: 'us-west-2', name: 'US West (Oregon)' },
  { id: 'eu-west-1', name: 'Europe (Ireland)' },
  { id: 'eu-west-2', name: 'Europe (London)' },
  { id: 'eu-west-3', name: 'Europe (Paris)' },
  { id: 'eu-central-1', name: 'Europe (Frankfurt)' },
  { id: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' },
  { id: 'ap-northeast-2', name: 'Asia Pacific (Seoul)' },
  { id: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
  { id: 'ap-southeast-2', name: 'Asia Pacific (Sydney)' },
  { id: 'ap-south-1', name: 'Asia Pacific (Mumbai)' },
];

interface RegionSelectorProps {
  value: string;
  onChange: (region: string) => void;
}

export function RegionSelector({ value, onChange }: RegionSelectorProps) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-foreground">Region</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="bedrock-region-select"
        className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm"
      >
        {AWS_REGIONS.map((region) => (
          <option key={region.id} value={region.id}>
            {region.id}
          </option>
        ))}
      </select>
    </div>
  );
}
