// A connection whose count statement comes back empty.

const dialect = {
  placeholderStyle: "qmark",
  quoteIdentifier: (name) => `"${name}"`,
  renderIn: (column, values, bind) => `${column} IN (${values.map(bind).join(", ")})`,
  renderCurrentTimeMillis: () => "0",
};

export const Connection = {
  create: async (resource) => ({
    dialect,
    execute: async (sql) => ({ rows: sql.includes("COUNT(*)") ? [] : resource.rows }),
  }),
};
