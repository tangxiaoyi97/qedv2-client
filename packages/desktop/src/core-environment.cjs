/** A desktop Core must use its bundled bank, never a host's management state. */
function desktopCoreEnvironment(environment) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith('MANAGEMENT_'))),
    MANAGEMENT_ENABLED: 'false',
  };
}

module.exports = { desktopCoreEnvironment };
