package internals

import (
	"context"
	_ "unsafe" // unsafe is needed to use go:linkname

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

//go:linkname awaitWithContext github.com/pulumi/pulumi/sdk/v3/go/pulumi.awaitWithContext
func awaitWithContext(ctx context.Context, o pulumi.Output) (interface{}, bool, bool, []pulumi.Resource, error)

// UnsafeAwaitOutputResult is an output from a Pulumi function or resource that has been resolved.
//
// This is a low level API and should be used with care.
type UnsafeAwaitOutputResult struct {
	Value        interface{}       // The value of the output. If unknown (in a dry-run), the value will be nil.
	Known        bool              // True if the value is known.
	Secret       bool              // True if the value is a secret.
	Dependencies []pulumi.Resource // The resources that this output depends on.
}

// UnsafeAwaitOutput blocks until the output is resolved and returns the resolved value and
// metadata.
//
// This is a low level API and should be used with care.
func UnsafeAwaitOutput(ctx context.Context, o pulumi.Output) (UnsafeAwaitOutputResult, error) {
	value, known, secret, deps, err := awaitWithContext(ctx, o)

	return UnsafeAwaitOutputResult{
		Value:        value,
		Known:        known,
		Secret:       secret,
		Dependencies: deps,
	}, err
}
