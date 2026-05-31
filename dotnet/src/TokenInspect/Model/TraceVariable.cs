namespace TokenInspect;
public sealed record TraceVariable(string Name, VariableKind Kind, string Value)
{
    public static TraceVariable Jwt(string name, string value)    => new(name, VariableKind.Jwt, value);
    public static TraceVariable Opaque(string name, string value) => new(name, VariableKind.Opaque, value);
    public static TraceVariable Code(string name, string value)   => new(name, VariableKind.Code, value);
    public static TraceVariable Url(string name, string value)    => new(name, VariableKind.Url, value);
    public static TraceVariable Hash(string name, string value)   => new(name, VariableKind.Hash, value);
    public static TraceVariable Plain(string name, string value)  => new(name, VariableKind.Plain, value);
    public static TraceVariable Json(string name, string value)   => new(name, VariableKind.Json, value);
}
