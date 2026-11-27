package encoding

import (
	"bytes"
	"encoding/json"
	"math/big"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
)

// directDepositVectorsPath is the fixture test/Escrow.directDepositVectors.t.sol runs through the
// real escrow. The TypeScript encoder asserts the same file.
const directDepositVectorsPath = "../../../../conformance/direct-deposit-vectors.json"

type directDepositVectors struct {
	ChainID        uint64         `json:"chainID"`
	Escrow         common.Address `json:"escrow"`
	Owner          common.Address `json:"owner"`
	Token          common.Address `json:"token"`
	Nonce          string         `json:"nonce"`
	Amount         string         `json:"amount"`
	DepositWitness struct {
		DepositRequestHash common.Hash    `json:"depositRequestHash"`
		Destination        string         `json:"destination"`
		Reserver           common.Address `json:"reserver"`
		Releaser           common.Address `json:"releaser"`
	} `json:"depositWitness"`
	DepositWitnessHash    common.Hash   `json:"depositWitnessHash"`
	DepositID             common.Hash   `json:"depositId"`
	DirectDepositCalldata hexutil.Bytes `json:"directDepositCalldata"`
	FundingBatch          []struct {
		To   common.Address `json:"to"`
		Data hexutil.Bytes  `json:"data"`
	} `json:"fundingBatch"`
	UnreservedDepositHash common.Hash `json:"unreservedDepositHash"`
	Reserve               struct {
		QuoteHash           common.Hash    `json:"quoteHash"`
		Settler             common.Address `json:"settler"`
		SourceAmount        string         `json:"sourceAmount"`
		FeeAmount           string         `json:"feeAmount"`
		ReserveSignature    hexutil.Bytes  `json:"reserveSignature"`
		ReserveCalldata     hexutil.Bytes  `json:"reserveCalldata"`
		ReservedDepositHash common.Hash    `json:"reservedDepositHash"`
		DepositReservedLog  struct {
			Topics []common.Hash `json:"topics"`
			Data   hexutil.Bytes `json:"data"`
		} `json:"depositReservedLog"`
	} `json:"reserve"`
}

func loadDirectDepositVectors(t *testing.T) directDepositVectors {
	t.Helper()
	raw, err := os.ReadFile(directDepositVectorsPath)
	if err != nil {
		t.Fatalf("read %s: %v", directDepositVectorsPath, err)
	}
	var v directDepositVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse %s: %v", directDepositVectorsPath, err)
	}
	if len(v.FundingBatch) != 3 {
		t.Fatalf("fixture funding batch has %d calls, want 3", len(v.FundingBatch))
	}
	return v
}

func mustBig(t *testing.T, s string) *big.Int {
	t.Helper()
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		t.Fatalf("not a decimal integer: %q", s)
	}
	return n
}

func (v directDepositVectors) witness() contracts.IEscrowDepositWitness {
	return contracts.IEscrowDepositWitness{
		DepositRequestHash: v.DepositWitness.DepositRequestHash,
		Destination:        v.DepositWitness.Destination,
		Reserver:           v.DepositWitness.Reserver,
		Releaser:           v.DepositWitness.Releaser,
	}
}

func (v directDepositVectors) directInput(t *testing.T) contracts.IEscrowDirectDepositInput {
	return contracts.IEscrowDirectDepositInput{
		Token:          v.Token,
		Amount:         mustBig(t, v.Amount),
		Nonce:          mustBig(t, v.Nonce),
		DepositWitness: v.witness(),
	}
}

func (v directDepositVectors) reserveInput(t *testing.T) contracts.IEscrowReserveInput {
	return contracts.IEscrowReserveInput{
		Depositor:      v.Owner,
		Token:          v.Token,
		Amount:         mustBig(t, v.Amount),
		DepositWitness: v.witness(),
		ReserveWitness: contracts.IEscrowReserveWitness{
			DepositId:    v.DepositID,
			QuoteHash:    v.Reserve.QuoteHash,
			Settler:      v.Reserve.Settler,
			SourceAmount: mustBig(t, v.Reserve.SourceAmount),
		},
		ReserveSignature: v.Reserve.ReserveSignature,
	}
}

func (v directDepositVectors) depositID(t *testing.T) common.Hash {
	t.Helper()
	id, err := DirectDepositID(new(big.Int).SetUint64(v.ChainID), v.Escrow, v.Owner, v.Token,
		mustBig(t, v.Nonce), v.witness(), mustBig(t, v.Amount))
	if err != nil {
		t.Fatalf("DirectDepositID: %v", err)
	}
	return id
}

// The constants the encoder carries are read back from Escrow.sol, so a contract change that
// moves one fails here rather than in a signature a verifier rejects.
func TestDirectDepositConstantsMatchEscrowSource(t *testing.T) {
	if got, want := DirectDepositDomainTag, escrowTypeHashFromSource(t, "DIRECT_DEPOSIT_DOMAIN_TAG"); got != want {
		t.Errorf("DirectDepositDomainTag = %s, Escrow.sol DIRECT_DEPOSIT_DOMAIN_TAG = %s", got, want)
	}
	if got, want := depositWitnessTypeHash, escrowTypeHashFromSource(t, "DEPOSIT_WITNESS_TYPE_HASH"); got != want {
		t.Errorf("depositWitnessTypeHash = %s, Escrow.sol DEPOSIT_WITNESS_TYPE_HASH = %s", got, want)
	}

	re := regexp.MustCompile(`constant\s+MAX_DESTINATION_BYTES\s*=\s*(\d+)\s*;`)
	m := re.FindAllStringSubmatch(escrowSourceCode(t), -1)
	if len(m) != 1 {
		t.Fatalf("expected exactly one MAX_DESTINATION_BYTES declaration in Escrow.sol, found %d", len(m))
	}
	if n, _ := strconv.Atoi(m[0][1]); n != MaxDestinationBytes {
		t.Errorf("MaxDestinationBytes = %d, Escrow.sol MAX_DESTINATION_BYTES = %d", MaxDestinationBytes, n)
	}
}

func TestReserveSelectorIsPinned(t *testing.T) {
	data, err := EncodeReserve(loadDirectDepositVectors(t).reserveInput(t))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data[:4], []byte{0xb4, 0xb6, 0x91, 0x3b}) {
		t.Fatalf("reserve selector = %x", data[:4])
	}
}

// Cross-language golden: every output equals the Solidity-bound fixture.
func TestDirectDepositVectors(t *testing.T) {
	v := loadDirectDepositVectors(t)

	if got := DepositWitnessHash(v.witness()); got != v.DepositWitnessHash {
		t.Errorf("DepositWitnessHash = %s, want %s", got, v.DepositWitnessHash)
	}
	if got := v.depositID(t); got != v.DepositID {
		t.Errorf("DirectDepositID = %s, want %s", got, v.DepositID)
	}

	input := v.directInput(t)
	calldata, err := EncodeDirectDeposit(input)
	if err != nil {
		t.Fatalf("EncodeDirectDeposit: %v", err)
	}
	if !bytes.Equal(calldata, v.DirectDepositCalldata) {
		t.Errorf("directDeposit calldata\n got  %x\n want %x", calldata, []byte(v.DirectDepositCalldata))
	}

	batch, err := DirectDepositFundingBatch(v.Escrow, input)
	if err != nil {
		t.Fatalf("DirectDepositFundingBatch: %v", err)
	}
	if len(batch) != len(v.FundingBatch) {
		t.Fatalf("batch has %d calls, want %d", len(batch), len(v.FundingBatch))
	}
	for i, want := range v.FundingBatch {
		if batch[i].To != want.To || !bytes.Equal(batch[i].Data, want.Data) {
			t.Errorf("batch[%d] = %s %x, want %s %x", i, batch[i].To, batch[i].Data, want.To, []byte(want.Data))
		}
	}

	owner := v.Owner
	unreserved, err := UnreservedActiveDeposit(owner, v.Token, input.Amount, v.witness())
	if err != nil {
		t.Fatal(err)
	}
	unreservedHash, err := unreserved.Hash()
	if err != nil {
		t.Fatal(err)
	}
	if unreservedHash != v.UnreservedDepositHash {
		t.Errorf("unreserved hash = %s, want %s", unreservedHash, v.UnreservedDepositHash)
	}

	reserveCalldata, err := EncodeReserve(v.reserveInput(t))
	if err != nil {
		t.Fatalf("EncodeReserve: %v", err)
	}
	if !bytes.Equal(reserveCalldata, v.Reserve.ReserveCalldata) {
		t.Errorf("reserve calldata\n got  %x\n want %x", reserveCalldata, []byte(v.Reserve.ReserveCalldata))
	}

	// The reserved hash, from the inputs (fee as an input) and from the log overlay.
	fee := mustBig(t, v.Reserve.FeeAmount)
	reserved, err := ReservedActiveDeposit(unreserved, v.Reserve.QuoteHash, v.Reserve.Settler,
		mustBig(t, v.Reserve.SourceAmount), fee)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := reserved.Hash(); got != v.Reserve.ReservedDepositHash {
		t.Errorf("reserved hash = %s, want %s", got, v.Reserve.ReservedDepositHash)
	}

	event, err := DecodeDepositReserved(types.Log{
		Topics: v.Reserve.DepositReservedLog.Topics,
		Data:   v.Reserve.DepositReservedLog.Data,
	})
	if err != nil {
		t.Fatalf("DecodeDepositReserved: %v", err)
	}
	if event.DepositId != v.DepositID || event.QuoteHash != v.Reserve.QuoteHash || event.Settler != v.Reserve.Settler ||
		event.Amount.String() != v.Reserve.SourceAmount || event.FeeAmount.String() != v.Reserve.FeeAmount {
		t.Errorf("decoded log = %+v", event)
	}
	overlaid, err := ApplyDepositReserved(v.DepositID, unreserved, event)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := overlaid.Hash(); got != v.Reserve.ReservedDepositHash {
		t.Errorf("overlaid hash = %s, want %s", got, v.Reserve.ReservedDepositHash)
	}
	// The overlay must not have aliased or mutated the deposit-time tuple.
	if again, _ := unreserved.Hash(); again != v.UnreservedDepositHash {
		t.Errorf("overlay mutated the unreserved tuple: %s", again)
	}
}

// Changing any member of the id preimage changes the id.
func TestDirectDepositIDBindsEveryPreimageMember(t *testing.T) {
	v := loadDirectDepositVectors(t)
	chain := new(big.Int).SetUint64(v.ChainID)
	nonce, amount := mustBig(t, v.Nonce), mustBig(t, v.Amount)
	other := common.HexToAddress("0x00000000000000000000000000000000deadbeef")

	derive := func(chain *big.Int, escrow, owner, token common.Address, nonce *big.Int,
		w contracts.IEscrowDepositWitness, amount *big.Int) common.Hash {
		id, err := DirectDepositID(chain, escrow, owner, token, nonce, w, amount)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	base := derive(chain, v.Escrow, v.Owner, v.Token, nonce, v.witness(), amount)

	witnessWith := func(f func(*contracts.IEscrowDepositWitness)) contracts.IEscrowDepositWitness {
		w := v.witness()
		f(&w)
		return w
	}
	cases := map[string]common.Hash{
		"chainID": derive(big.NewInt(1), v.Escrow, v.Owner, v.Token, nonce, v.witness(), amount),
		"escrow":  derive(chain, other, v.Owner, v.Token, nonce, v.witness(), amount),
		"owner":   derive(chain, v.Escrow, other, v.Token, nonce, v.witness(), amount),
		"token":   derive(chain, v.Escrow, v.Owner, other, nonce, v.witness(), amount),
		"nonce":   derive(chain, v.Escrow, v.Owner, v.Token, big.NewInt(8), v.witness(), amount),
		"amount":  derive(chain, v.Escrow, v.Owner, v.Token, nonce, v.witness(), new(big.Int).Add(amount, big.NewInt(1))),
		"depositRequestHash": derive(chain, v.Escrow, v.Owner, v.Token, nonce,
			witnessWith(func(w *contracts.IEscrowDepositWitness) { w.DepositRequestHash[0] ^= 1 }), amount),
		"destination": derive(chain, v.Escrow, v.Owner, v.Token, nonce,
			witnessWith(func(w *contracts.IEscrowDepositWitness) { w.Destination += "x" }), amount),
		"reserver": derive(chain, v.Escrow, v.Owner, v.Token, nonce,
			witnessWith(func(w *contracts.IEscrowDepositWitness) { w.Reserver = other }), amount),
		"releaser": derive(chain, v.Escrow, v.Owner, v.Token, nonce,
			witnessWith(func(w *contracts.IEscrowDepositWitness) { w.Releaser = other }), amount),
	}
	for member, id := range cases {
		if id == base {
			t.Errorf("changing %s did not change the deposit id", member)
		}
	}
}

// A direct id and a Permit2 id over the same depositor, nonce and witness differ, and the domain
// tag cannot be a left-padded address, which is how a Permit2 preimage starts.
func TestDirectDepositIDDiffersFromPermit2ID(t *testing.T) {
	v := loadDirectDepositVectors(t)
	nonce := mustBig(t, v.Nonce)
	permit2ID, err := NewEscrowPaymentIdEncoder().Digest(v.Owner, v.Reserve.ReserveSignature, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(permit2ID, v.DepositID.Bytes()) {
		t.Fatal("direct deposit id equals a Permit2 id over the same inputs")
	}
	if bytes.Equal(DirectDepositDomainTag[:12], make([]byte, 12)) {
		t.Fatal("domain tag has a zero upper half, so it could be read as a left-padded address")
	}
}

func TestDirectDepositEncodersRejectInputsTheEscrowReverts(t *testing.T) {
	v := loadDirectDepositVectors(t)

	t.Run("directDeposit", func(t *testing.T) {
		mutate := map[string]func(*contracts.IEscrowDirectDepositInput){
			"zero amount":    func(i *contracts.IEscrowDirectDepositInput) { i.Amount = big.NewInt(0) },
			"negative nonce": func(i *contracts.IEscrowDirectDepositInput) { i.Nonce = big.NewInt(-1) },
			"nil amount":     func(i *contracts.IEscrowDirectDepositInput) { i.Amount = nil },
			"zero token":     func(i *contracts.IEscrowDirectDepositInput) { i.Token = common.Address{} },
			"zero reserver":  func(i *contracts.IEscrowDirectDepositInput) { i.DepositWitness.Reserver = common.Address{} },
			"zero releaser":  func(i *contracts.IEscrowDirectDepositInput) { i.DepositWitness.Releaser = common.Address{} },
			"empty request hash": func(i *contracts.IEscrowDirectDepositInput) {
				i.DepositWitness.DepositRequestHash = [32]byte{}
			},
			"empty destination": func(i *contracts.IEscrowDirectDepositInput) { i.DepositWitness.Destination = "" },
			"destination over the cap": func(i *contracts.IEscrowDirectDepositInput) {
				i.DepositWitness.Destination = strings.Repeat("a", MaxDestinationBytes+1)
			},
		}
		for name, f := range mutate {
			input := v.directInput(t)
			f(&input)
			if _, err := EncodeDirectDeposit(input); err == nil {
				t.Errorf("%s: EncodeDirectDeposit accepted it", name)
			}
			if _, err := DirectDepositFundingBatch(v.Escrow, input); err == nil {
				t.Errorf("%s: DirectDepositFundingBatch accepted it", name)
			}
		}
		atCap := v.directInput(t)
		atCap.DepositWitness.Destination = strings.Repeat("a", MaxDestinationBytes)
		if _, err := EncodeDirectDeposit(atCap); err != nil {
			t.Errorf("a destination at the cap is valid: %v", err)
		}
	})

	t.Run("reserve", func(t *testing.T) {
		mutate := map[string]func(*contracts.IEscrowReserveInput){
			"zero settler": func(i *contracts.IEscrowReserveInput) { i.ReserveWitness.Settler = common.Address{} },
			"empty quote":  func(i *contracts.IEscrowReserveInput) { i.ReserveWitness.QuoteHash = [32]byte{} },
			"zero charge":  func(i *contracts.IEscrowReserveInput) { i.ReserveWitness.SourceAmount = big.NewInt(0) },
			"charge > amount": func(i *contracts.IEscrowReserveInput) {
				i.ReserveWitness.SourceAmount = new(big.Int).Add(i.Amount, big.NewInt(1))
			},
			"zero depositor": func(i *contracts.IEscrowReserveInput) { i.Depositor = common.Address{} },
			"zero amount":    func(i *contracts.IEscrowReserveInput) { i.Amount = big.NewInt(0) },
			"bad witness":    func(i *contracts.IEscrowReserveInput) { i.DepositWitness.Destination = "" },
		}
		for name, f := range mutate {
			input := v.reserveInput(t)
			f(&input)
			if _, err := EncodeReserve(input); err == nil {
				t.Errorf("%s: EncodeReserve accepted it", name)
			}
		}
		full := v.reserveInput(t)
		full.ReserveWitness.SourceAmount = new(big.Int).Set(full.Amount)
		if _, err := EncodeReserve(full); err != nil {
			t.Errorf("a charge equal to the deposit is valid: %v", err)
		}
	})
}

// The id is only returned for a deposit the escrow would accept, so DirectDepositID refuses the same
// inputs EncodeDirectDeposit does, a zero token included.
func TestDirectDepositIDRejectsInputsTheEscrowReverts(t *testing.T) {
	v := loadDirectDepositVectors(t)
	chain := new(big.Int).SetUint64(v.ChainID)
	mutate := map[string]func(token *common.Address, nonce, amount **big.Int, w *contracts.IEscrowDepositWitness){
		"zero token":     func(tok *common.Address, _, _ **big.Int, _ *contracts.IEscrowDepositWitness) { *tok = common.Address{} },
		"zero amount":    func(_ *common.Address, _, a **big.Int, _ *contracts.IEscrowDepositWitness) { *a = big.NewInt(0) },
		"negative nonce": func(_ *common.Address, n, _ **big.Int, _ *contracts.IEscrowDepositWitness) { *n = big.NewInt(-1) },
		"zero reserver": func(_ *common.Address, _, _ **big.Int, w *contracts.IEscrowDepositWitness) {
			w.Reserver = common.Address{}
		},
		"empty destination": func(_ *common.Address, _, _ **big.Int, w *contracts.IEscrowDepositWitness) { w.Destination = "" },
		"empty request hash": func(_ *common.Address, _, _ **big.Int, w *contracts.IEscrowDepositWitness) {
			w.DepositRequestHash = [32]byte{}
		},
	}
	for name, f := range mutate {
		token, nonce, amount, w := v.Token, mustBig(t, v.Nonce), mustBig(t, v.Amount), v.witness()
		f(&token, &nonce, &amount, &w)
		if _, err := DirectDepositID(chain, v.Escrow, v.Owner, token, nonce, w, amount); err == nil {
			t.Errorf("%s: DirectDepositID returned an id for a deposit the escrow would reject", name)
		}
	}
}

func TestDepositReservedOverlayRefusesMismatches(t *testing.T) {
	v := loadDirectDepositVectors(t)
	unreserved, err := UnreservedActiveDeposit(v.Owner, v.Token, mustBig(t, v.Amount), v.witness())
	if err != nil {
		t.Fatal(err)
	}
	log := types.Log{Topics: v.Reserve.DepositReservedLog.Topics, Data: v.Reserve.DepositReservedLog.Data}
	event, err := DecodeDepositReserved(log)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := ApplyDepositReserved(common.Hash{1}, unreserved, event); err == nil {
		t.Error("an overlay for another deposit's id was accepted")
	}
	if _, err := ApplyDepositReserved(v.DepositID, unreserved, nil); err == nil {
		t.Error("a nil event was accepted")
	}
	over := *event
	over.Amount = new(big.Int).Add(mustBig(t, v.Amount), big.NewInt(1))
	if _, err := ApplyDepositReserved(v.DepositID, unreserved, &over); err == nil {
		t.Error("a charge above the deposited amount was accepted")
	}

	wrongTopic := log
	wrongTopic.Topics = []common.Hash{{9}, v.DepositID}
	if _, err := DecodeDepositReserved(wrongTopic); err == nil {
		t.Error("a log with another topic0 decoded as DepositReserved")
	}
	noID := log
	noID.Topics = log.Topics[:1]
	if _, err := DecodeDepositReserved(noID); err == nil {
		t.Error("a log without the indexed depositId decoded")
	}
	short := log
	short.Data = log.Data[:len(log.Data)-1]
	if _, err := DecodeDepositReserved(short); err == nil {
		t.Error("a log with truncated data decoded")
	}
}

// Each field of the tuple reaches the hash: changing one changes it.
func TestActiveDepositHashBindsEveryField(t *testing.T) {
	v := loadDirectDepositVectors(t)
	reservedBase, err := ReservedActiveDeposit(
		mustUnreserved(t, v), v.Reserve.QuoteHash, v.Reserve.Settler,
		mustBig(t, v.Reserve.SourceAmount), mustBig(t, v.Reserve.FeeAmount))
	if err != nil {
		t.Fatal(err)
	}
	base, _ := reservedBase.Hash()
	other := common.HexToAddress("0x00000000000000000000000000000000deadbeef")
	mutate := map[string]func(*ActiveDeposit){
		"depositor":          func(a *ActiveDeposit) { a.Depositor = other },
		"quoteHash":          func(a *ActiveDeposit) { a.QuoteHash[0] ^= 1 },
		"depositRequestHash": func(a *ActiveDeposit) { a.DepositRequestHash[0] ^= 1 },
		"destinationHash":    func(a *ActiveDeposit) { a.DestinationHash[0] ^= 1 },
		"token":              func(a *ActiveDeposit) { a.Token = other },
		"amount":             func(a *ActiveDeposit) { a.Amount = big.NewInt(1) },
		"feeAmount":          func(a *ActiveDeposit) { a.FeeAmount = big.NewInt(1) },
		"reserver":           func(a *ActiveDeposit) { a.Reserver = other },
		"releaser":           func(a *ActiveDeposit) { a.Releaser = other },
		"settler":            func(a *ActiveDeposit) { a.Settler = other },
	}
	for field, f := range mutate {
		a := reservedBase
		a.Amount, a.FeeAmount = new(big.Int).Set(a.Amount), new(big.Int).Set(a.FeeAmount)
		f(&a)
		if h, _ := a.Hash(); h == base {
			t.Errorf("changing %s did not change the active-deposit hash", field)
		}
	}
	if _, err := (ActiveDeposit{}).Hash(); err == nil {
		t.Error("a tuple with nil amounts hashed")
	}
}

func mustUnreserved(t *testing.T, v directDepositVectors) ActiveDeposit {
	t.Helper()
	u, err := UnreservedActiveDeposit(v.Owner, v.Token, mustBig(t, v.Amount), v.witness())
	if err != nil {
		t.Fatal(err)
	}
	return u
}
