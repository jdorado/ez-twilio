export function fail(code, message, exitCode = 2, details = {}) {
  return Object.assign(new Error(message), {code, exitCode, details});
}

export function publicError(error) {
  return error?.exitCode && typeof error.code === 'string'
    ? {code: error.code, message: error.message, exitCode: error.exitCode, ...error.details}
    : {code: 'INTERNAL', message: 'Operation failed; inspect plugin status without exposing private state', exitCode: 1};
}
