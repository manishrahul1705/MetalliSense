import { format, formatDistance, formatRelative } from "date-fns";

/**
 * Format number to fixed decimal places
 * @param {number} value
 * @param {number} decimals
 * @returns {string}
 */
export const formatNumber = (value, decimals = 2) => {
  return Number(value).toFixed(decimals);
};

/**
 * Format percentage
 * @param {number} value
 * @param {number} decimals
 * @returns {string}
 */
export const formatPercentage = (value, decimals = 2) => {
  return `${formatNumber(value, decimals)}%`;
};

/**
 * Format date to readable string
 * @param {Date|string} date
 * @returns {string}
 */
export const formatDate = (date) => {
  if (!date) return "N/A";
  return format(new Date(date), "MMM dd, yyyy HH:mm:ss");
};

/**
 * Format date to relative time (e.g., "2 hours ago")
 * @param {Date|string} date
 * @returns {string}
 */
export const formatRelativeDate = (date) => {
  if (!date) return "N/A";
  return formatDistance(new Date(date), new Date(), { addSuffix: true });
};

/**
 * Format composition object to readable string
 * @param {Object} composition
 * @returns {string}
 */
export const formatComposition = (composition) => {
  return Object.entries(composition)
    .map(([element, value]) => `${element}: ${formatPercentage(value)}`)
    .join(", ");
};

/**
 * Format confidence score
 * @param {number} confidence
 * @returns {string}
 */
export const formatConfidence = (confidence) => {
  return formatPercentage(confidence * 100, 1);
};

/**
 * Truncate text to specified length
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
export const truncateText = (text, maxLength = 50) => {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
};

/**
 * Format file size
 * @param {number} bytes
 * @returns {string}
 */
export const formatFileSize = (bytes) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
};
