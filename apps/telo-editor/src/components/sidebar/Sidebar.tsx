import type {
  ModuleKind,
  ModuleViewData,
  ParsedManifest,
  RegistryServer,
  Workspace,
} from "../../model";
import { DefinitionsSection } from "./DefinitionsSection";
import { ImportsSection } from "./ImportsSection";
import { ResourcesSection } from "./ResourcesSection";
import { SectionDivider } from "./primitives";
import { WorkspaceTree } from "./WorkspaceTree";

interface SidebarProps {
  workspace: Workspace | null;
  activeManifest: ParsedManifest | null;
  activeModulePath: string | null;
  selectedResource: { kind: string; name: string } | null;
  graphContext: { kind: string; name: string } | null;
  registryServers: RegistryServer[];
  viewData: ModuleViewData | null;
  onSelectResource: (kind: string, name: string) => void;
  onNavigateResource: (kind: string, name: string) => void;
  onOpenModule: (filePath: string) => void;
  onCreateModule: (kind: ModuleKind, relativePath: string, name: string) => Promise<void>;
  onDeleteModule: (filePath: string) => Promise<void>;
  onRunModule: (filePath: string) => void;
  onAddImport: (source: string, alias: string) => Promise<void>;
  onRemoveImport: (name: string) => void;
  onUpgradeImport: (name: string, newSource: string) => Promise<void>;
  onCreateResource: () => void;
}

export function Sidebar({
  workspace,
  activeManifest,
  activeModulePath,
  selectedResource,
  graphContext,
  registryServers,
  viewData,
  onSelectResource,
  onNavigateResource,
  onOpenModule,
  onCreateModule,
  onDeleteModule,
  onRunModule,
  onAddImport,
  onRemoveImport,
  onUpgradeImport,
  onCreateResource,
}: SidebarProps) {
  return (
    <div className="flex h-full w-56 flex-col overflow-y-auto border-r border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-950">
      {workspace && (
        <>
          <WorkspaceTree
            workspace={workspace}
            activeModulePath={activeModulePath}
            onOpenModule={onOpenModule}
            onCreateModule={onCreateModule}
            onDeleteModule={onDeleteModule}
            onRunModule={onRunModule}
          />
          <SectionDivider />
        </>
      )}
      <ImportsSection
        activeManifest={activeManifest}
        registryServers={registryServers}
        onAddImport={onAddImport}
        onRemoveImport={onRemoveImport}
        onUpgradeImport={onUpgradeImport}
      />
      <SectionDivider />
      <ResourcesSection
        activeManifest={activeManifest}
        viewData={viewData}
        selectedResource={selectedResource}
        graphContext={graphContext}
        onNavigateResource={onNavigateResource}
        onCreateResource={onCreateResource}
      />
      <SectionDivider />
      <DefinitionsSection
        activeManifest={activeManifest}
        selectedResource={selectedResource}
        onSelectResource={onSelectResource}
      />
    </div>
  );
}
