import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Star, Trash2, Pencil, Plus } from 'lucide-react'
import {
  addAddress,
  disposeAddress,
  setDefaultAddress as setDefaultAddressService,
  subscribeAddresses,
  updateAddress,
} from '../services/firestoreService'
import { loadMapsLibrary } from '../services/googleMaps'
import type { Address } from '../types'

interface Props {
  hId: string
  onBack: () => void
}

type View = 'list' | 'form'

type CountryCode = '+91' | '+1' | '+44' | '+971' | '+65'

const COUNTRY_CODES: Array<{ code: CountryCode; label: string }> = [
  { code: '+91',  label: '+91 (IN)' },
  { code: '+1',   label: '+1 (US)'  },
  { code: '+44',  label: '+44 (UK)' },
  { code: '+971', label: '+971 (AE)' },
  { code: '+65',  label: '+65 (SG)' },
]

const LABEL_CHIPS = ["Dad's place", "Mom's place", 'Parents', 'Home', 'Other']

// Persona-anchored fallback center for the map when neither edit-target nor
// geolocation provides a starting point. Priya/Rajan are in Bengaluru per
// CLAUDE.md, so this matches the primary user before any place is picked.
const DEFAULT_CENTER = { lat: 12.9716, lng: 77.5946 }

interface FormState {
  label: string
  recipientName: string
  countryCode: CountryCode
  recipientPhoneLocal: string
  houseNumber: string
  apartmentName: string
  area: string
  city: string
  state: string
  pincode: string
  country: string
  landmark: string
  placeId: string
  latitude: number | null
  longitude: number | null
  formattedAddress: string
  isDefault: boolean
}

const EMPTY_FORM: FormState = {
  label: '',
  recipientName: '',
  countryCode: '+91',
  recipientPhoneLocal: '',
  houseNumber: '',
  apartmentName: '',
  area: '',
  city: '',
  state: '',
  pincode: '',
  country: 'IN',
  landmark: '',
  placeId: '',
  latitude: null,
  longitude: null,
  formattedAddress: '',
  isDefault: false,
}

// Splits an E.164 phone back into (countryCode, localDigits) so the form can
// reconstruct the original two-input shape when editing.
function splitPhone(phone: string): { code: CountryCode; local: string } {
  for (const { code } of COUNTRY_CODES) {
    if (phone.startsWith(code)) {
      return { code, local: phone.slice(code.length) }
    }
  }
  return { code: '+91', local: phone }
}

// Extracts the fields we care about from a Google address-component array.
// Returns only what the API gave us; the caller decides how to merge with
// the existing form (typically: keep user-typed houseNumber + landmark,
// overwrite the rest).
function extractAddressComponents(
  components: google.maps.GeocoderAddressComponent[],
): Pick<FormState, 'apartmentName' | 'area' | 'city' | 'state' | 'pincode' | 'country'> {
  const longOf = (type: string) =>
    components.find(c => c.types.includes(type))?.long_name ?? ''
  const shortOf = (type: string) =>
    components.find(c => c.types.includes(type))?.short_name ?? ''
  return {
    apartmentName:
      longOf('premise') ||
      longOf('point_of_interest') ||
      longOf('establishment') ||
      '',
    area:
      longOf('sublocality_level_1') ||
      longOf('sublocality') ||
      longOf('neighborhood') ||
      '',
    city: longOf('locality') || longOf('administrative_area_level_2') || '',
    state: longOf('administrative_area_level_1') || '',
    pincode: longOf('postal_code'),
    country: shortOf('country') || 'IN',
  }
}

export function Addresses({ hId, onBack }: Props) {
  const [view, setView] = useState<View>('list')
  const [addresses, setAddresses] = useState<Address[] | null>(null)
  const [listError, setListError] = useState('')
  const [editing, setEditing] = useState<Address | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Address | null>(null)

  useEffect(() => {
    const unsub = subscribeAddresses(
      hId,
      list => {
        setAddresses(list)
        setListError('')
      },
      () => setListError('Could not load addresses.'),
    )
    return unsub
  }, [hId])

  function openAddForm() {
    setEditing(null)
    setView('form')
  }

  function openEditForm(addr: Address) {
    setEditing(addr)
    setView('form')
  }

  async function handleSetDefault(addressId: string) {
    try {
      await setDefaultAddressService(hId, addressId)
    } catch {
      setListError('Could not set default.')
    }
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return
    try {
      await disposeAddress(hId, pendingDelete.addressId)
      setPendingDelete(null)
    } catch {
      setListError('Could not delete address.')
      setPendingDelete(null)
    }
  }

  if (view === 'form') {
    return (
      <AddressForm
        hId={hId}
        existing={editing}
        onCancel={() => setView('list')}
        onSaved={() => setView('list')}
      />
    )
  }

  return (
    <div className="cb-view">
      <div className="cb-subheader">
        <button
          type="button"
          className="cb-back-btn"
          onClick={onBack}
          aria-label="Back to settings"
        >
          <ChevronLeft size={20} />
        </button>
        <h2 className="cb-page-title">Delivery Addresses</h2>
      </div>

      {listError && <p className="cb-form-error" role="alert">{listError}</p>}

      <button
        type="button"
        className="cb-submit-btn"
        onClick={openAddForm}
        style={{ marginBottom: 12 }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Plus size={16} /> Add address
        </span>
      </button>

      {addresses === null ? (
        <div className="cb-loader"><div className="cb-spinner" role="status" aria-label="Loading" /></div>
      ) : addresses.length === 0 ? (
        <p className="cb-hint" style={{ textAlign: 'center', padding: '24px 0' }}>
          No saved addresses yet.
        </p>
      ) : (
        <ul className="ad-list">
          {addresses.map(a => (
            <li key={a.addressId} className="ad-card db-card">
              <div className="ad-card-header">
                <span className="ad-card-label">{a.label}</span>
                {a.isDefault && (
                  <span className="ad-default-badge">Default</span>
                )}
              </div>
              <div className="ad-card-recipient">
                {a.recipientName} · {a.recipientPhone}
              </div>
              <div className="ad-card-address">{a.formattedAddress}</div>
              {a.landmark && (
                <div className="ad-card-landmark">Near {a.landmark}</div>
              )}
              <div className="ad-card-actions">
                {!a.isDefault && (
                  <button
                    type="button"
                    className="ad-card-action"
                    onClick={() => handleSetDefault(a.addressId)}
                    aria-label={`Set ${a.label} as default`}
                  >
                    <Star size={14} /> Set default
                  </button>
                )}
                <button
                  type="button"
                  className="ad-card-action"
                  onClick={() => openEditForm(a)}
                  aria-label={`Edit ${a.label}`}
                >
                  <Pencil size={14} /> Edit
                </button>
                <button
                  type="button"
                  className="ad-card-action ad-card-action--danger"
                  onClick={() => setPendingDelete(a)}
                  aria-label={`Delete ${a.label}`}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete && (
        <div
          className="db-modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setPendingDelete(null)}
        >
          <div className="db-modal" onClick={e => e.stopPropagation()}>
            <h3 className="db-modal-title">Delete this address?</h3>
            <p className="st-danger-warn">
              <strong>{pendingDelete.label}</strong> · {pendingDelete.formattedAddress}
            </p>
            <div className="st-danger-actions">
              <button
                type="button"
                className="st-danger-btn-cancel"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="st-danger-btn-confirm"
                onClick={handleConfirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface FormProps {
  hId: string
  existing: Address | null
  onCancel: () => void
  onSaved: () => void
}

function AddressForm({ hId, existing, onCancel, onSaved }: FormProps) {
  const isEdit = existing !== null

  const [form, setForm] = useState<FormState>(() => {
    if (!existing) return EMPTY_FORM
    const { code, local } = splitPhone(existing.recipientPhone)
    return {
      label: existing.label,
      recipientName: existing.recipientName,
      countryCode: code,
      recipientPhoneLocal: local,
      houseNumber: existing.houseNumber,
      apartmentName: existing.apartmentName ?? '',
      area: existing.area,
      city: existing.city,
      state: existing.state,
      pincode: existing.pincode,
      country: existing.country,
      landmark: existing.landmark ?? '',
      placeId: existing.placeId,
      latitude: existing.latitude,
      longitude: existing.longitude,
      formattedAddress: existing.formattedAddress,
      isDefault: existing.isDefault,
    }
  })

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [mapError, setMapError] = useState('')

  // Refs to imperative Google Maps objects. Created once when the SDK loads,
  // mutated thereafter via setPosition / setCenter rather than re-rendered.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const markerRef = useRef<google.maps.Marker | null>(null)
  const geocoderRef = useRef<google.maps.Geocoder | null>(null)
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)

  // Mount the map + autocomplete only in add mode. In edit mode the
  // location-bearing fields (placeId/lat/lng/formattedAddress) are immutable
  // per the AK-163 update whitelist, so the map and search bar would be
  // misleading affordances.
  useEffect(() => {
    if (isEdit) return
    let cancelled = false

    loadMapsLibrary()
      .then(() => {
        if (cancelled || !mapContainerRef.current) return

        const map = new google.maps.Map(mapContainerRef.current, {
          center:
            form.latitude !== null && form.longitude !== null
              ? { lat: form.latitude, lng: form.longitude }
              : DEFAULT_CENTER,
          zoom: form.latitude !== null ? 17 : 13,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
        })
        mapRef.current = map

        // Using google.maps.Marker (classic) rather than AdvancedMarkerElement.
        // AdvancedMarkerElement requires a Cloud-Console-issued Map ID; the
        // classic API works without any extra Cloud setup. Marker is marked
        // deprecated but has Google's 12-month-minimum support guarantee,
        // which is enough runway for this ticket's beta scope.
        const marker = new google.maps.Marker({
          map,
          position: map.getCenter()!,
          draggable: true,
        })
        markerRef.current = marker

        geocoderRef.current = new google.maps.Geocoder()

        marker.addListener('dragend', () => {
          const pos = marker.getPosition()
          if (!pos) return
          void reverseGeocode({ lat: pos.lat(), lng: pos.lng() })
        })

        if (searchInputRef.current) {
          const ac = new google.maps.places.Autocomplete(searchInputRef.current, {
            componentRestrictions: { country: 'in' },
            fields: [
              'place_id',
              'geometry',
              'formatted_address',
              'address_components',
              'name',
            ],
          })
          autocompleteRef.current = ac

          ac.addListener('place_changed', () => {
            const place = ac.getPlace()
            applyPlace(place)
          })
        }
      })
      .catch(() => {
        if (!cancelled) setMapError('Could not load the map. Check your connection.')
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit])

  function applyPlace(place: google.maps.places.PlaceResult) {
    if (!place.geometry?.location || !place.place_id) return
    const lat = place.geometry.location.lat()
    const lng = place.geometry.location.lng()

    mapRef.current?.panTo({ lat, lng })
    mapRef.current?.setZoom(17)
    markerRef.current?.setPosition({ lat, lng })

    const extracted = place.address_components
      ? extractAddressComponents(place.address_components)
      : null

    setForm(prev => ({
      ...prev,
      placeId: place.place_id!,
      latitude: lat,
      longitude: lng,
      formattedAddress: place.formatted_address ?? '',
      // Place name often carries the apartment/society. Only overwrite if
      // the user hasn't typed something already.
      apartmentName:
        prev.apartmentName.trim() !== ''
          ? prev.apartmentName
          : (extracted?.apartmentName || place.name || ''),
      area: extracted?.area || prev.area,
      city: extracted?.city || prev.city,
      state: extracted?.state || prev.state,
      pincode: extracted?.pincode || prev.pincode,
      country: extracted?.country || prev.country,
    }))
  }

  async function reverseGeocode(loc: { lat: number; lng: number }) {
    if (!geocoderRef.current) return
    try {
      const response = await geocoderRef.current.geocode({ location: loc })
      const result = response.results[0]
      if (!result) return
      const extracted = extractAddressComponents(result.address_components)
      setForm(prev => ({
        ...prev,
        placeId: result.place_id,
        latitude: loc.lat,
        longitude: loc.lng,
        formattedAddress: result.formatted_address,
        // Keep user-typed houseNumber + landmark untouched; refresh the
        // place-derived fields to match the dragged location.
        apartmentName: extracted.apartmentName || prev.apartmentName,
        area: extracted.area || prev.area,
        city: extracted.city || prev.city,
        state: extracted.state || prev.state,
        pincode: extracted.pincode || prev.pincode,
        country: extracted.country || prev.country,
      }))
    } catch {
      // Geocode failures leave the form alone; the user can still drag again
      // or type the address fields manually.
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  // Required fields per AK-163 spec, plus the location triple that's only
  // present after a place pick / drag. In edit mode lat/lng/placeId already
  // exist on the existing record so the triple check trivially passes.
  const required =
    form.label.trim() !== '' &&
    form.recipientName.trim() !== '' &&
    /\d/.test(form.recipientPhoneLocal) &&
    form.recipientPhoneLocal.replace(/\D/g, '').length >= 7 &&
    form.houseNumber.trim() !== '' &&
    form.area.trim() !== '' &&
    form.city.trim() !== '' &&
    form.state.trim() !== '' &&
    /^\d{6}$/.test(form.pincode) &&
    form.country.trim() !== '' &&
    form.placeId !== '' &&
    form.latitude !== null &&
    form.longitude !== null &&
    form.formattedAddress.trim() !== ''
  const canSave = required && !saving

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setSaveError('')
    const fullPhone = `${form.countryCode}${form.recipientPhoneLocal.replace(/\D/g, '')}`
    try {
      if (isEdit && existing) {
        await updateAddress(hId, existing.addressId, {
          label: form.label.trim(),
          recipientName: form.recipientName.trim(),
          recipientPhone: fullPhone,
          houseNumber: form.houseNumber.trim(),
          apartmentName: form.apartmentName.trim() || null,
          area: form.area.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          pincode: form.pincode.trim(),
          country: form.country.trim(),
          landmark: form.landmark.trim() || null,
        })
        if (form.isDefault && !existing.isDefault) {
          await setDefaultAddressService(hId, existing.addressId)
        }
      } else {
        const newId = await addAddress(hId, {
          label: form.label.trim(),
          recipientName: form.recipientName.trim(),
          recipientPhone: fullPhone,
          houseNumber: form.houseNumber.trim(),
          apartmentName: form.apartmentName.trim() || null,
          area: form.area.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          pincode: form.pincode.trim(),
          country: form.country.trim(),
          landmark: form.landmark.trim() || null,
          placeId: form.placeId,
          latitude: form.latitude!,
          longitude: form.longitude!,
          formattedAddress: form.formattedAddress,
          isDefault: false,
        })
        if (form.isDefault) {
          await setDefaultAddressService(hId, newId)
        }
      }
      onSaved()
    } catch {
      setSaveError("Couldn't save the address. Try again.")
      setSaving(false)
    }
  }

  return (
    <div className="cb-view">
      <div className="cb-subheader">
        <button
          type="button"
          className="cb-back-btn"
          onClick={onCancel}
          aria-label="Back to address list"
        >
          <ChevronLeft size={20} />
        </button>
        <h2 className="cb-page-title">{isEdit ? 'Edit address' : 'Add address'}</h2>
      </div>

      {!isEdit && (
        <>
          <div className="cb-field" style={{ marginBottom: 8 }}>
            <label className="cb-label" htmlFor="ad-search">Search for the address</label>
            <input
              id="ad-search"
              ref={searchInputRef}
              type="text"
              className="cb-input"
              placeholder="Search for the address"
              autoComplete="off"
            />
          </div>

          {mapError && <p className="cb-form-error" role="alert">{mapError}</p>}

          <div ref={mapContainerRef} className="ad-map" />
        </>
      )}

      {isEdit && (
        <p className="cb-hint" style={{ marginBottom: 8 }}>
          To change the pinned location, delete this address and add it again.
        </p>
      )}

      <div className="cb-form">
        <div className="cb-field">
          <label className="cb-label" htmlFor="ad-house">House / Flat number</label>
          <input
            id="ad-house"
            type="text"
            className="cb-input"
            value={form.houseNumber}
            onChange={e => update('houseNumber', e.target.value)}
            placeholder="e.g., #401, Flat 12B"
            disabled={saving}
          />
        </div>

        <div className="cb-field">
          <label className="cb-label" htmlFor="ad-apt">Apartment / Society name</label>
          <input
            id="ad-apt"
            type="text"
            className="cb-input"
            value={form.apartmentName}
            onChange={e => update('apartmentName', e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="cb-field">
          <label className="cb-label" htmlFor="ad-area">Area / Locality</label>
          <input
            id="ad-area"
            type="text"
            className="cb-input"
            value={form.area}
            onChange={e => update('area', e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="cb-field-row">
          <div className="cb-field">
            <label className="cb-label" htmlFor="ad-city">City</label>
            <input
              id="ad-city"
              type="text"
              className="cb-input"
              value={form.city}
              onChange={e => update('city', e.target.value)}
              disabled={saving}
            />
          </div>
          <div className="cb-field">
            <label className="cb-label" htmlFor="ad-state">State</label>
            <input
              id="ad-state"
              type="text"
              className="cb-input"
              value={form.state}
              onChange={e => update('state', e.target.value)}
              disabled={saving}
            />
          </div>
        </div>

        <div className="cb-field-row">
          <div className="cb-field">
            <label className="cb-label" htmlFor="ad-pin">Pincode</label>
            <input
              id="ad-pin"
              type="text"
              className="cb-input"
              inputMode="numeric"
              maxLength={6}
              value={form.pincode}
              onChange={e => update('pincode', e.target.value.replace(/\D/g, ''))}
              disabled={saving}
            />
          </div>
          <div className="cb-field">
            <label className="cb-label" htmlFor="ad-country">Country</label>
            <input
              id="ad-country"
              type="text"
              className="cb-input cb-input--readonly"
              value={form.country}
              readOnly
              tabIndex={-1}
            />
          </div>
        </div>

        <div className="cb-field">
          <label className="cb-label" htmlFor="ad-landmark">Landmark (optional)</label>
          <input
            id="ad-landmark"
            type="text"
            className="cb-input"
            value={form.landmark}
            onChange={e => update('landmark', e.target.value)}
            placeholder="e.g., Opposite the temple"
            disabled={saving}
          />
        </div>

        <h3 className="st-section-title" style={{ marginTop: 8 }}>Recipient</h3>

        <div className="cb-field">
          <label className="cb-label" htmlFor="ad-rec-name">Name</label>
          <input
            id="ad-rec-name"
            type="text"
            className="cb-input"
            value={form.recipientName}
            onChange={e => update('recipientName', e.target.value)}
            placeholder="Who is this for?"
            disabled={saving}
          />
        </div>

        <div className="cb-field">
          <label className="cb-label" htmlFor="ad-rec-phone">Phone</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              className="cb-input cb-select"
              value={form.countryCode}
              onChange={e => update('countryCode', e.target.value as CountryCode)}
              disabled={saving}
              style={{ flex: '0 0 130px' }}
              aria-label="Country code"
            >
              {COUNTRY_CODES.map(c => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
            <input
              id="ad-rec-phone"
              type="tel"
              className="cb-input"
              inputMode="numeric"
              value={form.recipientPhoneLocal}
              onChange={e => update('recipientPhoneLocal', e.target.value)}
              placeholder="Phone number"
              disabled={saving}
              style={{ flex: 1 }}
            />
          </div>
        </div>

        <h3 className="st-section-title" style={{ marginTop: 8 }}>Save as</h3>

        <div className="cb-field">
          <label className="cb-label" htmlFor="ad-label">Label</label>
          <input
            id="ad-label"
            type="text"
            className="cb-input"
            value={form.label}
            onChange={e => update('label', e.target.value)}
            placeholder="e.g., Dad's place"
            disabled={saving}
          />
          <div className="ad-chip-row">
            {LABEL_CHIPS.map(chip => {
              const active = form.label === chip
              return (
                <button
                  key={chip}
                  type="button"
                  className={`ad-chip${active ? ' ad-chip--active' : ''}`}
                  onClick={() => update('label', chip)}
                  disabled={saving}
                >
                  {chip}
                </button>
              )
            })}
          </div>
        </div>

        <label className="ad-default-row">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={e => update('isDefault', e.target.checked)}
            disabled={saving}
          />
          <span>Set as default delivery address</span>
        </label>

        {saveError && (
          <p className="cb-form-error" role="alert" style={{ marginTop: 8 }}>
            {saveError}
          </p>
        )}

        <button
          type="button"
          className="cb-submit-btn"
          onClick={handleSave}
          disabled={!canSave}
          style={{ marginTop: 12 }}
        >
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save address'}
        </button>
      </div>

    </div>
  )
}
