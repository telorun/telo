// Minimal ambient declarations for @tauri-apps/plugin-fs. The full types ship
// with the package once installed; this shim keeps the editor compiling in the
// meantime.
declare module "@tauri-apps/plugin-fs" {
  export interface DirEntry {
    name: string;
    isDirectory: boolean;
    isFile: boolean;
    isSymlink: boolean;
  }

  export function readTextFile(path: string): Promise<string>;
  export function writeTextFile(path: string, contents: string): Promise<void>;
  export function readDir(path: string): Promise<DirEntry[]>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function exists(path: string): Promise<boolean>;
}
