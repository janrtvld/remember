// Source-backed answers are withheld until validation. These updates describe
// actual operations without exposing unvalidated model claims or source text.
export function residentProgressLabel(tool: string, action: unknown, dutch: boolean): string | null {
  const labels: Record<string, [string, string]> = {
    'remember_data:days': ['Ik zoek welke dagen beschikbaar zijn.', 'I’m checking which days are available.'],
    'remember_data:day_state': ['Ik haal je dagoverzicht op.', 'I’m reading your day overview.'],
    'remember_data:overview': ['Ik bekijk het overzicht van je activiteiten.', 'I’m reviewing your activity overview.'],
    'remember_data:activity': ['Ik zoek de relevante activiteiten op.', 'I’m finding the relevant activities.'],
    'remember_data:activity_details': [
      'Ik bekijk de details van die activiteit.',
      'I’m checking the activity details.',
    ],
    'remember_data:tasks': [
      'Ik bekijk de actuele stand van je taken.',
      'I’m checking the current state of your tasks.',
    ],
    'remember_data:notes': ['Ik zoek de relevante notities op.', 'I’m finding the relevant notes.'],
    remember_archive: ['Ik raadpleeg je opgeslagen gesprekken.', 'I’m reading your saved conversations.'],
    remember_memory: ['Ik raadpleeg de informatie in je Spaces.', 'I’m consulting the information in your Spaces.'],
    'remember_memory:create': ['Ik maak het document aan.', 'I’m creating the document.'],
    'remember_memory:patch': ['Ik werk het document bij.', 'I’m updating the document.'],
    'remember_memory:ensure': ['Ik bewaar de bron in je Space.', 'I’m saving the source in your Space.'],
    remember_task: ['Ik bekijk de taak en de gevraagde actie.', 'I’m reviewing the task and the requested action.'],
    remember_chat: [
      'Ik zoek eerdere berichten in ons gesprek op.',
      'I’m looking up earlier messages in our conversation.',
    ],
  }
  const pair = labels[`${tool}:${typeof action === 'string' ? action : ''}`] ?? labels[tool]
  return pair?.[dutch ? 0 : 1] ?? null
}
