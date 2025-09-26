const defaultPermissions = {
  admin: {
    CUSTOMER_CREATE: true,
    CUSTOMER_EDIT: true,
    TRANSACTION_CREATE: true,
    VIEW_REPORTS: true,
    MANAGE_STAFF: true,
    SETTINGS_ACCESS: true,
  },
  manager: {
    CUSTOMER_CREATE: true,
    CUSTOMER_EDIT: true,
    TRANSACTION_CREATE: true,
    VIEW_REPORTS: true,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
  },
  loan_officer: {
    CUSTOMER_CREATE: true,
    CUSTOMER_EDIT: true,
    TRANSACTION_CREATE: true,
    VIEW_REPORTS: true,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
  },
  teller: {
    CUSTOMER_CREATE: false,
    CUSTOMER_EDIT: false,
    TRANSACTION_CREATE: true,
    VIEW_REPORTS: false,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
  },
  viewer: {
    CUSTOMER_CREATE: false,
    CUSTOMER_EDIT: false,
    TRANSACTION_CREATE: false,
    VIEW_REPORTS: true,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
  }
};
