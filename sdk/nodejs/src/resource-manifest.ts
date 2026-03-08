/**
 * Type for resource manifest defined in YAML files
 */
export interface ResourceManifest {
  kind: string;
  metadata: {
    name: string;
    module?: string;
    [key: string]: any;
  };
  [key: string]: any;
}
