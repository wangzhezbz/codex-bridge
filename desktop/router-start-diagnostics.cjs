"use strict";

const MAX_DIAGNOSTIC_INPUT = 16 * 1024;

function classifyRouterProcessOutput(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  const text = value.slice(0, MAX_DIAGNOSTIC_INPUT);
  if (/\bEADDRINUSE\b|address already in use|only one usage of each socket address/iu.test(text)) {
    return "router_port_in_use";
  }
  if (/\blisten\b[\s\S]{0,160}\b(?:EACCES|EPERM)\b|\b(?:EACCES|EPERM)\b[\s\S]{0,160}\blisten\b/iu.test(text)) {
    return "router_port_permission_denied";
  }
  if (/SyntaxError:[^\r\n]{0,160}\bJSON\b|JSON[^\r\n]{0,160}(?:parse|Unexpected token)/iu.test(text)) {
    return "router_config_invalid";
  }
  return "";
}

module.exports = { classifyRouterProcessOutput };
