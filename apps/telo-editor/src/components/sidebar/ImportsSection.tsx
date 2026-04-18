import { useState } from "react";
import type { ParsedManifest, RegistryServer } from "../../model";
import { AddImportForm } from "./AddImportForm";
import { ImportRow } from "./ImportRow";
import { EmptyHint, SectionHeader } from "./primitives";
import { useImportUpgrade } from "./useImportUpgrade";

interface ImportsSectionProps {
  activeManifest: ParsedManifest | null;
  registryServers: RegistryServer[];
  onAddImport: (source: string, alias: string) => Promise<void>;
  onRemoveImport: (name: string) => void;
  onUpgradeImport: (name: string, newSource: string) => Promise<void>;
}

export function ImportsSection({
  activeManifest,
  registryServers,
  onAddImport,
  onRemoveImport,
  onUpgradeImport,
}: ImportsSectionProps) {
  const [adding, setAdding] = useState(false);
  const upgrade = useImportUpgrade(registryServers, onUpgradeImport);
  const imports = activeManifest?.imports ?? [];

  async function handleSubmit(source: string, alias: string) {
    await onAddImport(source, alias);
    setAdding(false);
  }

  return (
    <div className="pb-1 pt-2">
      <SectionHeader
        label="Imports"
        onAdd={activeManifest ? () => setAdding(true) : undefined}
      />
      {imports.length === 0 && !adding && <EmptyHint text="No imports" />}
      {imports.map((imp) => (
        <ImportRow key={imp.name} imp={imp} upgrade={upgrade} onRemove={onRemoveImport} />
      ))}
      {adding && (
        <AddImportForm
          registryServers={registryServers}
          onSubmit={handleSubmit}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}
