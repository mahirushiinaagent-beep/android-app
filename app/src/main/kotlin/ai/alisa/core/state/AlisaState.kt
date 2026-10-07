package ai.alisa.core.state

import ai.alisa.core.result.AlisaErrorCode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Central ALISA state. The UI only OBSERVES it; transitions happen only through [AlisaStateMachine]. */
sealed interface AlisaState {
    data object Idle : AlisaState
    data object Listening : AlisaState
    data object Thinking : AlisaState
    data object Speaking : AlisaState
    data class Error(val code: AlisaErrorCode) : AlisaState

    /** Hook for future states (e.g. "ACTING", "VERIFYING") without breaking consumers that have an else branch. */
    data class Extension(val id: String) : AlisaState
}

sealed interface AlisaEvent {
    data object StartListening : AlisaEvent
    data object SubmitText : AlisaEvent
    data object InputReceived : AlisaEvent
    data object ResponseReady : AlisaEvent
    data object ResponseSilent : AlisaEvent
    data object SpeechFinished : AlisaEvent
    data object Cancel : AlisaEvent
    data object Reset : AlisaEvent
    data class Fail(val code: AlisaErrorCode) : AlisaEvent
}

/** Pure transition table. Returns null for an illegal transition (state unchanged). */
object AlisaStateReducer {
    fun reduce(state: AlisaState, event: AlisaEvent): AlisaState? = when (event) {
        is AlisaEvent.Fail -> AlisaState.Error(event.code)
        AlisaEvent.Reset -> when (state) {
            is AlisaState.Error, is AlisaState.Extension -> AlisaState.Idle
            else -> null
        }
        AlisaEvent.Cancel -> when (state) {
            AlisaState.Listening, AlisaState.Thinking, AlisaState.Speaking -> AlisaState.Idle
            else -> null
        }
        AlisaEvent.StartListening -> if (state == AlisaState.Idle) AlisaState.Listening else null
        AlisaEvent.SubmitText -> if (state == AlisaState.Idle) AlisaState.Thinking else null
        AlisaEvent.InputReceived -> if (state == AlisaState.Listening) AlisaState.Thinking else null
        AlisaEvent.ResponseReady -> if (state == AlisaState.Thinking) AlisaState.Speaking else null
        AlisaEvent.ResponseSilent -> if (state == AlisaState.Thinking) AlisaState.Idle else null
        AlisaEvent.SpeechFinished -> if (state == AlisaState.Speaking) AlisaState.Idle else null
    }
}

class AlisaStateMachine(initial: AlisaState = AlisaState.Idle) {
    private val _state = MutableStateFlow(initial)
    val state: StateFlow<AlisaState> = _state.asStateFlow()

    /** @return true if the transition was applied, false if it was illegal (state unchanged). */
    @Synchronized
    fun dispatch(event: AlisaEvent): Boolean {
        val next = AlisaStateReducer.reduce(_state.value, event) ?: return false
        _state.value = next
        return true
    }
}
