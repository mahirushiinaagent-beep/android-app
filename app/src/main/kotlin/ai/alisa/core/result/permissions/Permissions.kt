package ai.alisa.core.permissions

/** Android permission identifiers understood by the ALISA core. */
enum class AlisaPermission {
    MICROPHONE,
    NOTIFICATIONS,
    BLUETOOTH_CONNECT,
    BLUETOOTH_SCAN,
    LOCATION,
}

/** Result of checking/requesting a permission. */
enum class PermissionState {
    GRANTED,
    DENIED,
    NOT_REQUESTED,
    NOT_APPLICABLE,
}
