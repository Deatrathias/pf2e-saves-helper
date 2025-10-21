const DEGREE_OF_SUCCESS = {
    CRITICAL_SUCCESS: 3,
    SUCCESS: 2,
    FAILURE: 1,
    CRITICAL_FAILURE: 0,
} as const;

const DEGREE_OF_SUCCESS_STRINGS = ["criticalFailure", "failure", "success", "criticalSuccess"] as const;

export { DEGREE_OF_SUCCESS, DEGREE_OF_SUCCESS_STRINGS };