export const defaultPermissions = {
  admin: {
    CUSTOMER_CREATE: true,
    CUSTOMER_EDIT: true,
    TRANSACTION_CREATE: true,
    VIEW_REPORTS: true,
    MANAGE_STAFF: true,
    SETTINGS_ACCESS: true,
    DELETE_CUSTOMER: true,
    ALTER_ACCOUNT: true,
    ALTER_FINANCE: true
  },
  manager: {
    CUSTOMER_CREATE: true,
    CUSTOMER_EDIT: true,
    TRANSACTION_CREATE: true,
    VIEW_REPORTS: true,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
    DELETE_CUSTOMER: true,
    ALTER_ACCOUNT: true,
    ALTER_FINANCE: true
  },
  loan_officer: {
    CUSTOMER_CREATE: false,
    CUSTOMER_EDIT: false,
    TRANSACTION_CREATE: false,
    VIEW_REPORTS: true,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
    DELETE_CUSTOMER: false,
    ALTER_ACCOUNT: false
  },
  mobile_banker: {
    CUSTOMER_CREATE: true,
    CUSTOMER_EDIT: true,
    TRANSACTION_CREATE: true,
    VIEW_REPORTS: true,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
    DELETE_CUSTOMER: false,
    ALTER_ACCOUNT: true
  },
  teller: {
    CUSTOMER_CREATE: false,
    CUSTOMER_EDIT: false,
    TRANSACTION_CREATE: true,
    VIEW_REPORTS: false,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
    DELETE_CUSTOMER: false,
    ALTER_ACCOUNT: false
  },
  viewer: {
    CUSTOMER_CREATE: false,
    CUSTOMER_EDIT: false,
    TRANSACTION_CREATE: false,
    VIEW_REPORTS: true,
    MANAGE_STAFF: false,
    SETTINGS_ACCESS: false,
    DELETE_CUSTOMER: false,
    ALTER_ACCOUNT: false
  }
};
