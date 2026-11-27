# Java and the JVM
Java is a general-purpose, object-oriented programming language designed to run on many platforms. Source code is compiled into bytecode, which the Java Virtual Machine executes on each supported operating system. This separation lets developers move the same program between machines that have compatible runtimes. The JVM also manages memory and performs runtime checks. For example, a developer can compile a command-line tool once and run it on Windows or Linux with a suitable Java runtime.

# Variables and Types
A variable is a named location that stores a value, and Java requires each variable to have a declared type. Primitive types such as int and boolean store simple values, while reference types point to objects. A type determines which operations are valid and helps the compiler find mistakes before execution. For example, an int can store a count of attempts, while a String can store a learner's name. Choose a type that clearly describes the data.

# Control Flow
Control flow is the order in which a program evaluates statements and chooses actions. Java uses if and else branches for decisions, and for or while loops for repeated work. A condition evaluates to true or false and determines which branch runs. Loops should update their state so they eventually finish. For example, a for loop can visit every item in a list and print its value, while an if statement can skip items that are inactive.

# Methods
A method is a named block of code that performs a task and can accept parameters and return a result. Methods help divide a program into understandable pieces and reduce duplicated logic. A method signature includes its name and parameter types, and its return type describes the result. For example, a calculateTotal method can accept a price and quantity and return their product. Small methods with clear names are easier to test and reuse.

# Classes and Objects
A class is a blueprint that defines the state and behavior shared by its objects. An object is a particular instance created from that class, with its own field values. Constructors initialize objects, while methods describe behavior. Encapsulation keeps an object's internal state controlled through an intentional public interface. For example, a BankAccount class can store a balance and provide a deposit method that validates positive amounts before changing it.

# Collections and Exceptions
Collections are objects that group other values, such as lists for ordered items and maps for key-value associations. Generics describe the element type and help prevent incompatible values from being added. Exceptions represent conditions that interrupt normal execution, and try-catch blocks let code respond to recoverable failures. For example, a program can keep a list of course names and catch a missing-file exception when loading saved course data.
