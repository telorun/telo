interface UnsupportedFieldProps {
  fieldPath: string;
}

export function UnsupportedField({ fieldPath }: UnsupportedFieldProps) {
  return (
    <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
      Unsupported field shape for form editing: {fieldPath}
    </div>
  );
}
