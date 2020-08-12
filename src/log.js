const winston = require('winston');

const { getNamespace, createNamespace } = require('cls-hooked');
const uuidv4 = require('uuid/v4');

const LOGGING_NAMESPACE_NAME = 'chain-data-api-log';
const CONTINUATION_ID_VAR_NAME = 'continuationId';

let loggingSession = getNamespace(LOGGING_NAMESPACE_NAME);
if (!loggingSession) {
  loggingSession = createNamespace(LOGGING_NAMESPACE_NAME);
}

function runWithContinuationId(value, continuation) {
  if (!value) {
    value = uuidv4();
  }
  let returnValue;
  loggingSession.run(() => {
    loggingSession.set(CONTINUATION_ID_VAR_NAME, value);
    returnValue = continuation();
  });
  return returnValue;
}

const continuationIdFormat = winston.format((info) => {
  const continuationId = loggingSession.get(CONTINUATION_ID_VAR_NAME)
  return {...info, continuationId };
});


const logger = winston.createLogger({
  format: winston.format.combine(winston.format.simple(), winston.format.timestamp(), continuationIdFormat()),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.simple(), winston.format.timestamp(), continuationIdFormat()),
      level: 'info',
      handleExceptions: true,
    }),
  ],
  exitOnError: false,
});

logger.runWithContinuationId = runWithContinuationId;
module.exports = logger;
