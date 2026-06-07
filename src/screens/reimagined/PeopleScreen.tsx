// Reimagined · People tab (AK-196). Real, Firestore-backed screens replacing
// the Phase-1 placeholder. Navigation between the list (MyPeople) and a single
// person (PersonDetail) is local state — no router needed.

import { useState } from 'react'
import { MyPeople } from './MyPeople'
import { PersonDetail } from './PersonDetail'

export function PeopleScreen() {
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null)

  if (selectedPersonId) {
    return <PersonDetail personId={selectedPersonId} onBack={() => setSelectedPersonId(null)} />
  }
  return <MyPeople onSelect={setSelectedPersonId} />
}
