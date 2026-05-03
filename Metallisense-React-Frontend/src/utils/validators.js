/**
 * Validate composition percentage
 * @param {number} value - Percentage value
 * @returns {boolean}
 */
export const isValidPercentage = (value) => {
  return !isNaN(value) && value >= 0 && value <= 100;
};

/**
 * Validate element symbol
 * @param {string} symbol - Element symbol
 * @param {Array} allowedElements - Array of allowed element symbols
 * @returns {boolean}
 */
export const isValidElement = (symbol, allowedElements) => {
  return allowedElements.includes(symbol);
};

/**
 * Validate grade composition object
 * @param {Object} composition - Composition object with element symbols as keys
 * @returns {Object} - { valid: boolean, errors: Array }
 */
export const validateComposition = (composition) => {
  const errors = [];

  Object.entries(composition).forEach(([element, range]) => {
    if (!range.min && range.min !== 0) {
      errors.push(`${element}: minimum value is required`);
    }
    if (!range.max && range.max !== 0) {
      errors.push(`${element}: maximum value is required`);
    }
    if (!isValidPercentage(range.min)) {
      errors.push(`${element}: minimum must be between 0-100`);
    }
    if (!isValidPercentage(range.max)) {
      errors.push(`${element}: maximum must be between 0-100`);
    }
    if (range.min > range.max) {
      errors.push(`${element}: minimum cannot be greater than maximum`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
};

/**
 * Validate grade name
 * @param {string} name - Grade name
 * @returns {boolean}
 */
export const isValidGradeName = (name) => {
  return name && name.trim().length > 0 && name.trim().length <= 50;
};

/**
 * Validate email format
 * @param {string} email
 * @returns {boolean}
 */
export const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};
