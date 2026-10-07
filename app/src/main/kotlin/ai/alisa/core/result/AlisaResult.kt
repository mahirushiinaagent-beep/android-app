package ai.alisa.core.result

import ai.alisa.core.permissions.AlisaPermission
import kotlin.coroutines.cancellation.CancellationException

/**
 * Error codes are fixed, non-secret identifiers. Messages are constant strings:
 * they never contain exception text, tokens, voice data or security internals.
 */
enum class AlisaErrorCode(val safeMessage: String) {
    UNEXPECTED("Something went wrong."),
    INVALID_TRANSITION("That action is not possible right now."),
    MICROPHONE_UNAVAILABLE("The microphone is not available."),
    INTELLIGENCE_NOT_CONNECTED("ALISA intelligence is not connected yet."),
    STORAGE_FAILED("Local storage could not be used."),
    ACTION_DENIED("This action is not permitted."),
}

data class AlisaError(val code: AlisaErrorCode, val message: String = code.safeMessage)

/** Uniform outcome model for every Android-layer operation. */
sealed interface AlisaResult<out T> {
    data class Success<T>(val value: T) : AlisaResult<T>
    data class Failed(val error: AlisaError) : AlisaResult<Nothing>
    data object Cancelled : AlisaResult<Nothing>
    data class RequiresPermission(val permission: AlisaPermission) : AlisaResult<Nothing>
    data object RequiresAuthentication : AlisaResult<Nothing>
    /** [reason] must be a constant, non-secret string. */
    data class NotAvailable(val reason: String) : AlisaResult<Nothing>
}

/** Runs [block]; any exception becomes a generic [AlisaResult.Failed] (its message is NOT propagated). Coroutine cancellation is rethrown. */
suspend fun <T> safeCall(block: suspend () -> T): AlisaResult<T> =
    try {
        AlisaResult.Success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        AlisaResult.Failed(AlisaError(AlisaErrorCode.UNEXPECTED))
    }
