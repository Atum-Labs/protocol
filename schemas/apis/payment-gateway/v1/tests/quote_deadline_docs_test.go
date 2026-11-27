package paymentgateway

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A payer reads quote_deadline's description to pick a window, and a settler declines a
// window on either side of what it can serve. The description has to give both bounds,
// the clock they are measured on, and, for a payment request, the case where the payer
// cannot retry freely.
func TestQuoteDeadlineDescriptionsDocumentBothWindowBounds(t *testing.T) {
	type source struct {
		desc string
		// A payment request can be funded by the payer's own deposit before any settler
		// sees it, and is a payment from the start; a quote request carries no deposit and
		// has no payment until an award, so neither the deposit nor the reissue-after-failure
		// advice applies to it.
		paymentRequest bool
	}
	sources := map[string]source{
		"PaymentRequest declaration": {paymentRequestDeclarationQuoteDeadline(t), true},
	}

	shapes := paymentRequestShapes(t)
	// The Quote API reaches the same settler pre-bid check, so the same bounds apply.
	const quoteRequest = "CreateQuoteRequest"
	wanted := map[string]bool{quoteRequest: true}
	for name := range shapes {
		wanted[name] = true
	}
	found := openapiQuoteDeadlines(t, wanted)

	generated := 0
	for schema, desc := range found {
		if shapes[schema] {
			generated++
		}
		sources["openapi "+schema] = source{desc, shapes[schema]}
	}
	if generated == 0 {
		t.Fatal("found no quote_deadline property in any openapi component schema generated from the PaymentRequest declaration")
	}
	// Named explicitly: canonical-shapes.yaml also lists nested shapes that carry no
	// quote_deadline, so its list alone cannot say which schemas must have one, and a
	// shape that silently loses its description would otherwise drop out of coverage.
	for _, schema := range []string{"PaymentRequest", "SubmitPaymentRequest", quoteRequest} {
		if _, ok := found[schema]; !ok {
			t.Errorf("found no quote_deadline description on openapi %s", schema)
		}
	}

	for name, src := range sources {
		t.Run(name, func(t *testing.T) {
			checkQuoteDeadlineDescription(t, src.desc, src.paymentRequest)
		})
	}
}

var settlerReceivesPattern = regexp.MustCompile(`(?i)\bsettler receives the request\b`)

func checkQuoteDeadlineDescription(t *testing.T, desc string, paymentRequest bool) {
	t.Helper()
	text := strings.Join(strings.Fields(desc), " ")
	lower := strings.ToLower(text)

	if !strings.Contains(text, "QUOTE_WINDOW_TOO_LONG") {
		t.Errorf("description does not name QUOTE_WINDOW_TOO_LONG, the upper bound: %q", text)
	}
	if !strings.Contains(text, "QUOTE_WINDOW_TOO_SHORT") {
		t.Errorf("description does not name QUOTE_WINDOW_TOO_SHORT, the lower bound: %q", text)
	}
	// The direction is the fix for a too-short window. A bare "longer" is not enough:
	// the upper-bound text already says "longer than their hold" about the opposite case.
	if !strings.Contains(lower, "longer quote_deadline") && !strings.Contains(lower, "later quote_deadline") {
		t.Errorf("description does not ask for a longer or later quote_deadline: %q", text)
	}

	// The lower bound is per settler, so a caller must not read any example as a floor.
	if !strings.Contains(lower, "no fixed minimum") {
		t.Errorf("description does not say there is no fixed minimum: %q", text)
	}

	// Both bounds run on the settler's clock from the moment the request reaches it, not
	// from when the payer built it, so transit time eats into the window. Anchored on the
	// settler receiving the request so "receiving price quotes" cannot satisfy it.
	if !settlerReceivesPattern.MatchString(text) {
		t.Errorf("description does not say the bounds are counted from when a settler receives the request: %q", text)
	}

	// One clock for both bounds. A bound counted from the settler's bid would put the
	// two bounds on different clocks, and the caller cannot see when a settler bids.
	if strings.Contains(lower, "from its bid") {
		t.Errorf("description anchors a bound to the settler's bid instead of its receipt of the request: %q", text)
	}

	// A longer window declined for some other reason is not the caller's to fix by
	// moving quote_deadline again; the description has to say where the cause lies.
	if !strings.Contains(lower, "settler's side") {
		t.Errorf("description does not say a longer window declined for another reason is on the settler's side: %q", text)
	}
	// Not every other decline is the settler's: some, such as a window that is now too long
	// or a source amount too low, are the caller's to fix. The decline message is not
	// forwarded, so the retry classification is the only signal a caller can branch on, and
	// the settler's-side claim must be scoped by it in the same sentence. Checked per
	// sentence so a mention of the classification elsewhere cannot stand in for the scope.
	for _, sentence := range splitSentences(text) {
		if !strings.Contains(strings.ToLower(sentence), "settler's side") {
			continue
		}
		if !strings.Contains(sentence, "retry_classification") || !strings.Contains(sentence, "NOT_RETRYABLE_FIX_REQUEST") {
			t.Errorf("sentence placing the cause on the settler's side does not limit it to declines whose retry_classification is not NOT_RETRYABLE_FIX_REQUEST: %q", sentence)
		}
		// Both names can appear in a clause with the polarity reversed, which would put the
		// caller's own fixes on the settler; the negation itself has to be stated.
		if !strings.Contains(sentence, "retry_classification is not NOT_RETRYABLE_FIX_REQUEST") {
			t.Errorf("sentence placing the cause on the settler's side does not state \"retry_classification is not NOT_RETRYABLE_FIX_REQUEST\": %q", sentence)
		}
	}
	// The unconditional form blames the settler for every other decline, including the
	// ones the caller must fix.
	if strings.Contains(lower, "for a different reason") {
		t.Errorf("description still blames the settler for any decline \"for a different reason\": %q", text)
	}

	if !paymentRequest {
		return
	}
	// The decline is visible while the payment is still pending; reissuing then can pay
	// twice, most of all after a direct deposit, so the reissue advice itself waits for
	// the failure. Matched with the verb because the refund advice also says "once the
	// payment has failed", and must not stand in for the reissue condition. A quote
	// request has no payment until an award, so reissuing it cannot double-pay.
	if !strings.Contains(lower, "once the payment has failed, reissue") {
		t.Errorf("description does not condition the reissue advice on the payment having failed: %q", text)
	}
	// A direct-deposit payer commits quote_deadline in the deposit it signs, so a declined
	// window cannot simply be resubmitted: the deadline is fixed before depositing and has
	// to leave room for the finality wait as well as both bounds.
	if !strings.Contains(lower, "direct deposit") {
		t.Errorf("description does not mention direct deposit: %q", text)
	}
	if !strings.Contains(lower, "before depositing") {
		t.Errorf("description does not say a direct-deposit payer fixes the deadline before depositing: %q", text)
	}
	if !strings.Contains(lower, "finality") {
		t.Errorf("description does not say the direct-deposit deadline must cover the finality wait: %q", text)
	}
	// The first deposit stays in escrow after its request is declined; the payer needs
	// the call that gets it back before reissuing with a second deposit.
	if !strings.Contains(text, "refundUnreserved") {
		t.Errorf("description does not name refundUnreserved as how the first deposit is recovered: %q", text)
	}
}

func paymentRequestDeclarationQuoteDeadline(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "declarations", "PaymentRequest", "v1", "schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Properties struct {
			QuoteDeadline struct {
				Description string `json:"description"`
			} `json:"quote_deadline"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Properties.QuoteDeadline.Description == "" {
		t.Fatal("PaymentRequest declaration has no quote_deadline description")
	}
	return doc.Properties.QuoteDeadline.Description
}

// paymentRequestShapes returns the component schemas generated from the PaymentRequest
// declaration, read from canonical-shapes.yaml so a new generated shape is covered
// without editing this test.
func paymentRequestShapes(t *testing.T) map[string]bool {
	t.Helper()
	shapes := map[string]bool{}
	for _, line := range readLines(t, filepath.Join("..", "canonical-shapes.yaml")) {
		if name, ok := strings.CutPrefix(line, "  - name: "); ok {
			shapes[strings.TrimSpace(name)] = true
		}
	}
	if len(shapes) == 0 {
		t.Fatal("canonical-shapes.yaml lists no shapes")
	}
	return shapes
}

// openapiQuoteDeadlines returns the quote_deadline description of each named component
// schema that has one, keyed by schema name.
func openapiQuoteDeadlines(t *testing.T, names map[string]bool) map[string]string {
	t.Helper()
	return openapiPropertyDescriptions(t, names, "quote_deadline")
}

// openapiPropertyDescriptions returns the description of property in each named component
// schema that has it, keyed by schema name.
func openapiPropertyDescriptions(t *testing.T, names map[string]bool, property string) map[string]string {
	t.Helper()
	// Indentation-driven scan of components.schemas: schema names sit at four spaces,
	// their properties at eight, and a block-scalar description's body deeper than ten.
	found := map[string]string{}
	inSchemas := false
	schema := ""
	lines := readLines(t, filepath.Join("..", "openapi.yaml"))
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		switch {
		case line == "  schemas:":
			inSchemas = true
			continue
		case inSchemas && len(line) > 0 && !strings.HasPrefix(line, "  "):
			inSchemas = false
		case inSchemas && strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "   ") && strings.TrimSpace(line) != "":
			inSchemas = false
		}
		if !inSchemas {
			continue
		}
		if strings.HasPrefix(line, "    ") && !strings.HasPrefix(line, "     ") && strings.HasSuffix(line, ":") {
			schema = strings.TrimSuffix(strings.TrimSpace(line), ":")
			continue
		}
		if line != "        "+property+":" || !names[schema] {
			continue
		}
		desc := ""
		for j := i + 1; j < len(lines); j++ {
			l := lines[j]
			if strings.TrimSpace(l) != "" && indent(l) <= 8 {
				break
			}
			if v, ok := strings.CutPrefix(l, "          description:"); ok {
				v = strings.TrimSpace(v)
				if v != "" && !strings.HasPrefix(v, "|") && !strings.HasPrefix(v, ">") {
					desc = v
					break
				}
				var body []string
				for k := j + 1; k < len(lines); k++ {
					if strings.TrimSpace(lines[k]) != "" && indent(lines[k]) <= 10 {
						break
					}
					body = append(body, strings.TrimSpace(lines[k]))
				}
				desc = strings.Join(body, "\n")
				break
			}
		}
		if desc == "" {
			t.Errorf("openapi %s.%s has no description", schema, property)
		}
		found[schema] = desc
	}
	return found
}

// sentenceEnd matches a period, question mark or exclamation mark that ends a sentence:
// followed by whitespace or the end of the text, so decimals and dotted identifiers do not
// split.
var sentenceEnd = regexp.MustCompile(`[.!?](\s+|$)`)

// splitSentences splits whitespace-normalised prose into sentences, keeping each one's
// terminator.
func splitSentences(text string) []string {
	var out []string
	start := 0
	for _, loc := range sentenceEnd.FindAllStringIndex(text, -1) {
		if s := strings.TrimSpace(text[start:loc[1]]); s != "" {
			out = append(out, s)
		}
		start = loc[1]
	}
	if s := strings.TrimSpace(text[start:]); s != "" {
		out = append(out, s)
	}
	return out
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 1024*1024)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

func indent(s string) int {
	return len(s) - len(strings.TrimLeft(s, " "))
}
