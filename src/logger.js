export const log = (...args) => console.log(new Date().toISOString(), ...args);
export const logError = (...args) => console.error(new Date().toISOString(), ...args);
