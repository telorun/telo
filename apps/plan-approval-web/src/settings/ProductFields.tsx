import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ProductSettings {
  name: string;
  deadline: string;
  webhookUrl: string;
}

/** The request body fields for a product's settings; an empty field is omitted. */
export function productSettingsBody(settings: ProductSettings) {
  return {
    name: settings.name,
    ...(settings.deadline.trim() === "" ? {} : { deadline: settings.deadline.trim() }),
    ...(settings.webhookUrl.trim() === "" ? {} : { webhookUrl: settings.webhookUrl.trim() }),
  };
}

export function ProductFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: ProductSettings;
  onChange: (value: ProductSettings) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={value.name}
          maxLength={200}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-deadline`}>Review deadline</Label>
        <Input
          id={`${idPrefix}-deadline`}
          placeholder="48h (empty: none)"
          value={value.deadline}
          onChange={(e) => onChange({ ...value, deadline: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-webhook`}>Webhook URL</Label>
        <Input
          id={`${idPrefix}-webhook`}
          placeholder="https://… (empty: none)"
          value={value.webhookUrl}
          onChange={(e) => onChange({ ...value, webhookUrl: e.target.value })}
        />
      </div>
    </>
  );
}
